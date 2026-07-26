/**
 * Active duel selection. Track A.
 *
 * Which two dishes to show next. This is the difference between a user
 * answering 15 questions and a user answering 60, so it is worth doing
 * properly.
 *
 * THE OBJECTIVE
 * A duel is informative when we genuinely cannot predict the answer AND the
 * answer would move theta. Those are different things, and optimizing either
 * alone fails:
 *
 *   - Maximize uncertainty alone and you get pairs that are unpredictable
 *     because they are nearly identical. The user learns nothing about
 *     themselves and neither do we.
 *   - Maximize difference alone and you get "deep-fried pork belly vs steamed
 *     greens" forever: a coin flip on personality, already predicted after two
 *     duels, and exhausting to answer.
 *
 * So the score is Bernoulli variance p(1-p), which peaks at p = 0.5, TIMES the
 * squared difference on axes we are still uncertain about. A pair scores high
 * only when the outcome is in doubt and the outcome would teach us something
 * about an axis we do not yet know.
 *
 * THE POPULATION FILTER
 * Independently of the user, a pair is excluded when the population agrees
 * above CONSENSUS_CEILING (everyone picks the same one, so the answer is a fact
 * about the dishes, not about the person) or below NOISE_FLOOR (the pick is a
 * coin flip for everyone, so it is noise, not taste). Both carry no information
 * about anyone and both are excluded from fitting and from the twin channel.
 */

import { AXIS_COUNT } from '../contracts/axes';
import { CONSTANTS, type Vec24 } from '../contracts/types';

export interface DuelCandidate {
  dishId: string;
  phi: Vec24;
  /** Indices of axes masked by low extraction confidence. */
  maskedIdx: number[];
  /**
   * Fraction of the population that picked this dish when it appeared. Undefined
   * for a dish that has not been shown enough times to have a rate yet.
   */
  populationWinRate?: number;
  /** How many times this dish has appeared in any duel. */
  appearances?: number;
  /** Hard rule 7: only verified dishes may be used for calibration. */
  verified: boolean;
  venueId?: string;
}

export interface SelectOptions {
  /** Current fitted vector. A zero vector is fine and means "we know nothing". */
  theta: Vec24;
  /**
   * Per-axis posterior variance from fitTheta.
   *
   * OFF BY DEFAULT, and that is a measured decision rather than an oversight.
   * The textbook criterion for a logistic model weights by d^T Sigma d, which
   * steers duels toward the axes we know least about. Against a SPARSE user
   * (strong opinions on a few axes, indifference on the rest) that is actively
   * harmful early: the unknown axes are mostly the ones the user does not care
   * about, so the duels probe irrelevant dimensions and the answers there are
   * genuine coin flips that the fit then reads as signal.
   *
   * Measured over 30 seeds (scripts/corpus/selection-experiment.ts), cosine to
   * a sparse truth:
   *
   *              10 duels  15 duels  30 duels
   *   random       0.464     0.541     0.712
   *   with Sigma   0.515     0.591     0.789
   *   without      0.536     0.617     0.780
   *
   * Unweighted wins where it matters (the first 15 duels, which is all a demo
   * or a first session ever sees) and gives up very little later.
   */
  axisVariance?: number[];
  /** Dish ids already shown to this user. Never repeat a pairing. */
  seenDishIds?: Set<string>;
  /** How many pairs to return. The feed pre-fetches a block so it never spins. */
  count?: number;
  /**
   * Candidate pairs to score. The full cross product of 8000 dishes is 32M
   * pairs, so we sample rather than enumerate.
   */
  samplePairs?: number;
  /**
   * Seed for candidate sampling. Defaults to random.
   *
   * Pass a fixed value only for reproducible tests. Never fix it in production:
   * a deterministic sample draws the same candidate pairs on every call, so
   * refitting between duels changes nothing about what is on offer. That bug
   * made active selection score WORSE than random pairing.
   */
  sampleSeed?: number;
}

export interface SelectedPair {
  a: DuelCandidate;
  b: DuelCandidate;
  /** Diagnostic only. Never shown to a user: it is a number about a person's data. */
  expectedInformation: number;
  predictedP: number;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * A pair is uninformative at the population level if everyone agrees, or if the
 * split is pure noise. Requires enough appearances to trust the rate at all.
 */
export function passesPopulationGate(a: DuelCandidate, b: DuelCandidate): boolean {
  const MIN_APPEARANCES = 8;
  const aSeen = a.appearances ?? 0;
  const bSeen = b.appearances ?? 0;

  // Not enough data to judge. A new dish is allowed through: excluding it would
  // mean no dish ever accumulates the appearances needed to be judged.
  if (aSeen < MIN_APPEARANCES || bSeen < MIN_APPEARANCES) return true;
  if (a.populationWinRate == null || b.populationWinRate == null) return true;

  // How lopsided is this matchup for the population, expressed as the share
  // going to the more popular dish.
  const total = a.populationWinRate + b.populationWinRate;
  if (total === 0) return true;
  const share = Math.max(a.populationWinRate, b.populationWinRate) / total;

  return share <= CONSTANTS.CONSENSUS_CEILING && share >= CONSTANTS.NOISE_FLOOR;
}

/**
 * Expected information from showing this pair.
 *
 * p(1-p) is how uncertain we are of the outcome. The weighted squared
 * difference is how much the outcome would move theta, counting axes we are
 * uncertain about more heavily. Masked axes contribute nothing.
 */
export function expectedInformation(
  a: DuelCandidate,
  b: DuelCandidate,
  theta: Vec24,
  axisVariance?: number[],
): { score: number; p: number } {
  const masked = new Set([...a.maskedIdx, ...b.maskedIdx]);

  let z = 0;
  let weightedDiff = 0;
  for (let i = 0; i < AXIS_COUNT; i++) {
    if (masked.has(i)) continue;
    const d = a.phi[i] - b.phi[i];
    z += theta[i] * d;
    // Uncertain axes are worth more. Without variance, all axes weigh equally.
    weightedDiff += (axisVariance ? axisVariance[i] : 1) * d * d;
  }

  const p = sigmoid(z);
  return { score: p * (1 - p) * weightedDiff, p };
}

/** Small seeded PRNG. Seeded per call so successive calls sample differently. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Select the next duels.
 *
 * Returns fewer than `count` when the verified pool cannot supply more without
 * repeating. Callers must handle a short result rather than assume the length,
 * because running out of verified dishes is a real state during a demo.
 */
export function selectDuels(
  pool: DuelCandidate[],
  options: SelectOptions,
): SelectedPair[] {
  const {
    theta,
    axisVariance,
    seenDishIds,
    count = 10,
    samplePairs = 3000,
    sampleSeed,
  } = options;

  // Hard rule 7. Calibration fits only on verified dishes, so an unverified
  // dish must never enter a duel that will be fitted on.
  const eligible = pool.filter((d) => d.verified && !(seenDishIds?.has(d.dishId) ?? false));
  if (eligible.length < 2) return [];

  // Score a random sample of pairs rather than the full cross product.
  const scored: SelectedPair[] = [];
  const seenPairs = new Set<string>();
  const n = eligible.length;
  const attempts = Math.min(samplePairs, (n * (n - 1)) / 2);
  const rand = rng(sampleSeed ?? ((Math.random() * 0xffffffff) >>> 0));

  for (let k = 0; k < attempts * 3 && scored.length < attempts; k++) {
    const i = Math.floor(rand() * n);
    const j = Math.floor(rand() * n);
    if (i === j) continue;

    const a = eligible[i];
    const b = eligible[j];

    // Two dishes from the same venue tell us about the venue, not the palate.
    if (a.venueId && a.venueId === b.venueId) continue;

    const pairKey = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    if (!passesPopulationGate(a, b)) continue;

    const { score, p } = expectedInformation(a, b, theta, axisVariance);
    if (score <= 0) continue;

    // JITTER, so two people do not get the same quiz.
    //
    // At theta = 0, which is every new user, p(1-p) is a constant 0.25 and the
    // score collapses to |d|^2. The argmax is then the same handful of extreme
    // pairs for everyone, so every first session asked nearly identical
    // questions and landed on the same read. Scaling by 0.7 to 1.3 keeps
    // high-information pairs strongly favored while letting the runners-up
    // surface, which is a real gain: a quiz that varies covers more of the
    // space across a population.
    const jittered = score * (0.7 + rand() * 0.6);

    scored.push({ a, b, expectedInformation: jittered, predictedP: p });
  }

  scored.sort((x, y) => y.expectedInformation - x.expectedInformation);

  // Greedy selection with no dish reused inside one block. Repeating a dish
  // across a block makes the feed feel like it is stuck, and the second
  // appearance carries much less information anyway.
  const out: SelectedPair[] = [];
  const used = new Set<string>();
  for (const pair of scored) {
    if (out.length >= count) break;
    if (used.has(pair.a.dishId) || used.has(pair.b.dishId)) continue;
    used.add(pair.a.dishId);
    used.add(pair.b.dishId);
    out.push(pair);
  }

  return out;
}

export const __testing = { sigmoid, rng };
