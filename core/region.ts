/**
 * Palate region and frontier scoring. Track A.
 *
 * This is the north star. Every recommender since Netflix maximizes predicted
 * enjoyment; this file measures and grows the region of the 24-space a person
 * actually eats in. Two things live here:
 *
 *   1. R_u, the region of attribute space where the user has positive ratings,
 *      plus a log-volume of R_u that is tracked over time.
 *   2. score(dish) = P(positive | theta) * novelty(distance from the BOUNDARY
 *      of R_u).
 *
 * WHY BOUNDARY DISTANCE AND NOT CENTROID DISTANCE
 * Centroid distance is monotone in alienness, so maximizing it means always
 * recommending the single most foreign thing in the corpus. That is how a
 * person who likes braises gets sent a plate of natto and gets told it is
 * discovery. Palates do not move like that. They move one axis at a time, so
 * the value of a dish peaks just outside the boundary and then falls: past a
 * point, a dish is not an expansion candidate, it is a dare that will not be
 * repeated and therefore will never enlarge R_u. The novelty kernel below is
 * unimodal for exactly this reason, and that unimodality is the whole idea.
 *
 * WHY A PER-AXIS SPREAD PRODUCT AND NOT A HULL
 * The honest region of a point cloud is its convex hull. In 24 dimensions a
 * hull needs at least 25 affinely independent points before it has any volume
 * at all, and a real user has eight logged dishes. A hull would therefore
 * report zero volume for every user we will ever have. So the region is
 * modelled as an axis-aligned box: per-axis centroid and per-axis spread. It
 * ignores correlation between axes, which is a real loss, and in exchange it is
 * defined and stable at n = 2, which is the n we actually have.
 *
 * ON HARD RULE 1
 * Palate volume is a number about a person, and it is the one such number the
 * product renders. The rule forbids numbers that rank or score a human being:
 * match percentages, similarity, reliability. Volume is first-person progress
 * against your own past self. It must never be shown next to another user's
 * volume, and nothing in this file returns another person's anything.
 *
 * ON HARD RULE 7
 * Rule 7 gates model FITTING to verified dishes. The region is not a fit, it is
 * a measurement of what this user ate and liked, and the long tail is where
 * expansion actually happens. So unverified dishes belong here, and `verified`
 * is deliberately not part of the input type.
 */

import { AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../contracts/axes';
import type { EvidencePacket, PalateRegion, Vec24 } from '../contracts/types';
import { predictPreference } from './model';

// ---------------------------------------------------------------------------
// Tunables. Track A owns these. They are not in CONSTANTS because CONSTANTS is
// a frozen shared contract and these are internal to the region model.
// ---------------------------------------------------------------------------

export const REGION_CONSTANTS = {
  /** A DishLog rating of 4 or 5 counts as positive. 3 is "fine", which is not evidence. */
  POSITIVE_RATING_MIN: 4,

  /** Below this many positive ratings there is no region. One point has no extent. */
  MIN_POSITIVES_FOR_REGION: 2,

  /**
   * Minimum credible half-width of the region on any axis, in z-units.
   *
   * A user with four tightly clustered dishes has a measured spread near zero,
   * and without a floor every other dish in the corpus is thousands of sd
   * outside their region. The floor says: with this little evidence we will not
   * claim a band narrower than half a z-unit. It also keeps the normalizer
   * below away from zero, which is the only division in this file.
   */
  SPREAD_FLOOR: 0.5,

  /** Scale for the log-volume metric. One z-unit of spread per axis. */
  SPREAD_UNIT: 1,

  /**
   * How far past the boundary, in floored-spread units, the ideal stretch sits.
   * Novelty peaks here and decays after.
   */
  ADJACENCY_SCALE: 1,

  /** Beyond this total boundary distance a dish is 'far' rather than 'adjacent'. */
  ADJACENT_MAX_DISTANCE: 2,

  /**
   * A dish outside on more axes than this is 'far' even if each step is small.
   * Palates move one axis at a time, and a dish that is new on six axes at once
   * cannot teach the user which of the six they liked.
   */
  ADJACENT_MAX_AXES: 3,

  /**
   * How distinctive a dish must be on an axis before it counts as evidence
   * about that axis. Everything is z-scored, so |phi| below this is
   * population-typical and says nothing.
   */
  FRONTIER_EPS: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Input and output types
// ---------------------------------------------------------------------------

/** One logged dish with the rating the user gave it. */
export interface RatedDish {
  dishId: string;
  phi: Vec24;
  /** 1..5, as in DishLog. */
  rating: number;
  /** Axes masked by low extraction confidence. Masked axes are not evidence. */
  maskedIdx?: number[];
}

/**
 * PalateRegion plus the geometry the scorer needs.
 *
 * The contract's PalateRegion carries only what is rendered. The extra fields
 * here never leave core, and `established` in particular must not be inferred
 * from `volume`, because an established region of identical dishes also has
 * volume 0.
 */
export interface ComputedRegion extends PalateRegion {
  /** Per-axis mean of positively-rated dishes. Zero on axes with no evidence. */
  centroid: Vec24;
  /** Per-axis sample sd. Zero where support is below 2. */
  spread: number[];
  /** spread floored by SPREAD_FLOOR. This is the actual boundary half-width. */
  halfWidth: number[];
  /** Count of unmasked positive observations per axis. */
  axisSupport: number[];
  positiveCount: number;
  /** False at cold start. When false, callers must not speak about a region. */
  established: boolean;
}

export interface FrontierCandidate {
  dishId: string;
  phi: Vec24;
  maskedIdx?: number[];
  /**
   * Optional calibrated P(positive). When absent it is derived from theta
   * against a population-average dish, which is the best available proxy.
   */
  pPositive?: number;
}

export interface FrontierScore {
  dishId: string;
  /** P(positive) * novelty. Ranking only. Never rendered: it is a number about a person's fit. */
  score: number;
  pPositive: number;
  /** Unimodal in boundaryDistance. Peaks at ADJACENCY_SCALE, decays after. */
  novelty: number;
  /** Euclidean norm of per-axis excess beyond the boundary, in floored-spread units. */
  boundaryDistance: number;
  outsideRegion: boolean;
  /** Axes on which this dish sits outside the region. */
  outsideAxes: AxisKey[];
  /** The axis with the largest excess. This is the axis the packet names. */
  primaryAxis: AxisKey | null;
  /** Null when the dish is inside the region or when there is no region yet. */
  distance: 'adjacent' | 'far' | null;
  /** False at cold start. Callers must omit EvidencePacket.expansion when false. */
  regionEstablished: boolean;
}

export interface ScoreOptions {
  /**
   * The dish P(positive) is measured against. Defaults to the zero vector,
   * which is the population-average dish because phi is z-scored.
   */
  reference?: Vec24;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeros(): number[] {
  return new Array(AXIS_COUNT).fill(0);
}

/**
 * Sample sd, n-1. Zero for fewer than two values.
 *
 * Population sd would understate the region at the n we operate at, and it is
 * the wrong direction to be wrong in: understating spread makes ordinary dishes
 * look like frontier dishes.
 */
function sampleSpread(values: number[], mean: number): number {
  const n = values.length;
  if (n < 2) return 0;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return Math.sqrt(ss / (n - 1));
}

function isPositive(d: RatedDish, minRating: number): boolean {
  return Number.isFinite(d.rating) && d.rating >= minRating;
}

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

export interface RegionOptions {
  /** Override the positive threshold. Defaults to REGION_CONSTANTS.POSITIVE_RATING_MIN. */
  positiveRatingMin?: number;
  /** Injected clock so a caller can produce a deterministic record. */
  now?: string;
}

/**
 * Compute the palate region from rated dishes.
 *
 * Guarantees, in order of how much they matter:
 *  - Every returned number is finite. Empty input, one observation, identical
 *    observations, and non-finite values inside a phi all produce a defined
 *    region rather than NaN or Infinity.
 *  - `established` is false with fewer than MIN_POSITIVES_FOR_REGION positives,
 *    and in that case volume is 0 and every axis is on the frontier. Volume 0
 *    is the floor of the metric, not a degenerate value.
 *  - Masked axes contribute nothing to centroid, spread, or volume. An axis
 *    masked on every positive dish stays on the frontier.
 *  - `volume` is comparable across users and across time: same axes, same
 *    z-units, same regularizer, no dependence on the number of observations
 *    beyond what the spread itself carries.
 *  - The result is invariant to the order of the input.
 */
export function computeRegion(logs: RatedDish[], options: RegionOptions = {}): ComputedRegion {
  const minRating = options.positiveRatingMin ?? REGION_CONSTANTS.POSITIVE_RATING_MIN;
  const positives = logs.filter((d) => isPositive(d, minRating));

  const centroid = zeros();
  const spread = zeros();
  const halfWidth = new Array<number>(AXIS_COUNT).fill(REGION_CONSTANTS.SPREAD_FLOOR);
  const axisSupport = zeros();
  const exploredAxes: AxisKey[] = [];
  const frontierAxes: AxisKey[] = [];

  // Per axis, only the positives where that axis is unmasked and finite. Axes
  // are treated independently, which is the whole simplification of the box
  // model, and it is also why a dish with one bad axis is not thrown away.
  for (let i = 0; i < AXIS_COUNT; i++) {
    const values: number[] = [];
    for (const d of positives) {
      if (d.maskedIdx?.includes(i)) continue;
      const v = d.phi?.[i];
      // An extractor can emit a NaN. Silently dropping it is correct here: it
      // is absence of evidence, exactly like a mask.
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      values.push(v);
    }

    axisSupport[i] = values.length;
    if (values.length === 0) {
      // No evidence. The region on this axis is a floor-width band around the
      // population mean, which is the honest prior: we have no reason to think
      // this person has eaten anything unusual here.
      frontierAxes.push(AXIS_KEYS[i]);
      continue;
    }

    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    centroid[i] = mean;
    spread[i] = sampleSpread(values, mean);
    halfWidth[i] = Math.max(spread[i], REGION_CONSTANTS.SPREAD_FLOOR);

    // Frontier: nothing this user liked is distinctive on this axis. Note that
    // this is direction-blind on purpose. A user who has only eaten mild food
    // has not explored heat, and the untouched territory is the whole axis.
    const maxAbs = values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (maxAbs < REGION_CONSTANTS.FRONTIER_EPS) {
      frontierAxes.push(AXIS_KEYS[i]);
      continue;
    }

    // Explored: some positively-rated dish sits at or past the boundary, which
    // is one sd from the centroid subject to the floor. Checked against the
    // floored width so that a cluster with near-zero measured spread does not
    // report exploration on the strength of rounding noise.
    const maxDev = values.reduce((m, v) => Math.max(m, Math.abs(v - mean)), 0);
    if (maxDev > halfWidth[i]) exploredAxes.push(AXIS_KEYS[i]);
  }

  const established = positives.length >= REGION_CONSTANTS.MIN_POSITIVES_FOR_REGION;

  // -------------------------------------------------------------------------
  // LOG-VOLUME
  //
  //   volume = sum_i log(1 + spread_i / SPREAD_UNIT)
  //
  // This is the log-volume of a box with sides (SPREAD_UNIT + spread_i), which
  // is the regularized version of the obvious sum of log(spread_i).
  //
  // The regularizer is load-bearing twice over. Without it, one axis with zero
  // measured spread sends the whole sum to -Infinity, so the metric would be
  // dominated by the axes a user has never touched rather than by the region
  // they have. And it puts the floor at exactly 0 for a user with no region, so
  // "volume grew" always means the same thing for everyone.
  //
  // Deliberately NOT floored by SPREAD_FLOOR: the floor exists to stop the
  // scorer over-claiming, while the metric should start at zero and move only
  // when real spread appears.
  //
  // This is an estimate, not a ratchet. Adding dishes inside the region tightens
  // the estimate and can move volume down a little. That is correct. A metric
  // that can only increase cannot detect the failure it exists to detect, which
  // is a palate that is not actually expanding.
  // -------------------------------------------------------------------------
  let volume = 0;
  if (established) {
    for (let i = 0; i < AXIS_COUNT; i++) {
      volume += Math.log1p(spread[i] / REGION_CONSTANTS.SPREAD_UNIT);
    }
  }

  // An axis cannot be both untouched and explored. Where the two rules disagree
  // the frontier wins, because claiming exploration on an axis where every dish
  // is population-typical is the more embarrassing of the two errors.
  const frontierSet = new Set<AxisKey>(frontierAxes);

  return {
    volume,
    exploredAxes: exploredAxes.filter((k) => !frontierSet.has(k)),
    frontierAxes,
    measuredAt: options.now ?? new Date().toISOString(),
    centroid,
    spread,
    halfWidth,
    axisSupport,
    positiveCount: positives.length,
    established,
  };
}

/**
 * Fractional growth in the underlying region volume between two measurements.
 *
 * Volume is a log quantity, so the readable "eating across 40% more of the
 * space" is exp(delta) - 1. Returns 0 rather than a non-finite number when
 * either measurement is missing or degenerate.
 */
export function volumeGrowthFraction(
  before: Pick<PalateRegion, 'volume'>,
  after: Pick<PalateRegion, 'volume'>,
): number {
  const a = before?.volume;
  const b = after?.volume;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const growth = Math.exp(b - a) - 1;
  return Number.isFinite(growth) ? growth : 0;
}

// ---------------------------------------------------------------------------
// Frontier scoring
// ---------------------------------------------------------------------------

/**
 * Novelty as a function of distance past the boundary.
 *
 *   novelty(x) = (x/A) * exp(1 - x/A)
 *
 * Zero at the boundary, peaks at exactly 1 when x = A, decays exponentially
 * after. The decay is the entire point of the file: it is what stops the
 * ranker from treating "most alien dish in the corpus" as "best discovery".
 */
function noveltyKernel(distance: number): number {
  const x = distance / REGION_CONSTANTS.ADJACENCY_SCALE;
  if (!Number.isFinite(x) || x <= 0) return 0;
  const n = x * Math.exp(1 - x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Score one dish for frontier value against a region.
 *
 * Guarantees:
 *  - score = pPositive * novelty, always, including at cold start.
 *  - A dish just past the boundary outranks a wildly alien dish of equal
 *    predicted enjoyment. This is the product's central claim and it is
 *    enforced by the shape of the kernel, not by a threshold.
 *  - A dish inside the region has boundaryDistance 0, novelty 0, distance null,
 *    and therefore contributes no expansion claim.
 *  - With no established region, novelty is a neutral 1 for every candidate, so
 *    ranking falls back to predicted enjoyment and no expansion is claimed.
 *  - Masked axes on the candidate contribute no distance. Absence of evidence
 *    is not evidence of novelty.
 *  - Every returned number is finite.
 */
export function scoreFrontier(
  candidate: FrontierCandidate,
  region: ComputedRegion,
  theta: Vec24,
  options: ScoreOptions = {},
): FrontierScore {
  const reference = options.reference ?? zeros();

  let pPositive = candidate.pPositive ?? predictPreference(theta, candidate.phi, reference);
  if (!Number.isFinite(pPositive)) pPositive = 0;
  pPositive = Math.min(1, Math.max(0, pPositive));

  if (!region.established) {
    // No region means no boundary, so there is nothing to be adjacent to. We
    // neither reward nor punish novelty here, and the caller must not emit an
    // expansion clause. Claiming a stretch against a region built from one
    // dinner would be a fabrication in the sense of hard rule 2.
    return {
      dishId: candidate.dishId,
      score: pPositive,
      pPositive,
      novelty: 1,
      boundaryDistance: 0,
      outsideRegion: false,
      outsideAxes: [],
      primaryAxis: null,
      distance: null,
      regionEstablished: false,
    };
  }

  const masked = candidate.maskedIdx ? new Set(candidate.maskedIdx) : null;
  const outsideAxes: AxisKey[] = [];
  let sumSq = 0;
  let topExcess = 0;
  let primaryAxis: AxisKey | null = null;

  for (let i = 0; i < AXIS_COUNT; i++) {
    if (masked?.has(i)) continue;
    const v = candidate.phi?.[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;

    // Axes with no positive evidence are handled by the centroid being 0 and
    // the half-width being the floor, set in computeRegion. A dish that is
    // extreme on an axis the user has never eaten on is genuinely outside the
    // region, and that case is the frontier at its most literal.
    const width = region.halfWidth[i] > 0 ? region.halfWidth[i] : REGION_CONSTANTS.SPREAD_FLOOR;
    const excess = Math.max(0, Math.abs(v - region.centroid[i]) - width) / width;
    if (excess <= 0) continue;

    outsideAxes.push(AXIS_KEYS[i]);
    sumSq += excess * excess;
    if (excess > topExcess) {
      topExcess = excess;
      primaryAxis = AXIS_KEYS[i];
    }
  }

  const boundaryDistance = Number.isFinite(sumSq) ? Math.sqrt(sumSq) : 0;
  const outsideRegion = outsideAxes.length > 0;
  const novelty = noveltyKernel(boundaryDistance);

  // Adjacency is two conditions, not one. A dish can be a small step on each of
  // eight axes and still be a completely foreign meal, and the user would not
  // be able to attribute the result to anything.
  const distance: 'adjacent' | 'far' | null = !outsideRegion
    ? null
    : boundaryDistance <= REGION_CONSTANTS.ADJACENT_MAX_DISTANCE &&
        outsideAxes.length <= REGION_CONSTANTS.ADJACENT_MAX_AXES
      ? 'adjacent'
      : 'far';

  return {
    dishId: candidate.dishId,
    score: pPositive * novelty,
    pPositive,
    novelty,
    boundaryDistance,
    outsideRegion,
    outsideAxes,
    primaryAxis,
    distance,
    regionEstablished: true,
  };
}

/**
 * Score and sort candidates, best frontier value first.
 *
 * Ties break on dishId so the order is deterministic, which matters because an
 * unstable order makes a feed look like it is shuffling on every refresh.
 */
export function rankFrontier(
  candidates: FrontierCandidate[],
  region: ComputedRegion,
  theta: Vec24,
  options: ScoreOptions = {},
): FrontierScore[] {
  return candidates
    .map((c) => scoreFrontier(c, region, theta, options))
    .sort((a, b) => b.score - a.score || a.dishId.localeCompare(b.dishId));
}

/**
 * Build the expansion clause of an EvidencePacket, or undefined.
 *
 * Undefined whenever there is no established region, the dish is inside it, or
 * no single axis drove the step. Returns exactly the three contract fields:
 * no distances, no scores, nothing numeric about the person. Callers must use
 * this rather than assembling the clause themselves, because it is the one
 * place the leak of a frontier number into a prompt can be prevented.
 */
export function expansionForPacket(
  score: FrontierScore,
): EvidencePacket['expansion'] | undefined {
  if (!score.regionEstablished) return undefined;
  if (!score.outsideRegion) return undefined;
  if (!score.primaryAxis || !score.distance) return undefined;
  return {
    outsideRegion: true,
    axis: score.primaryAxis,
    distance: score.distance,
  };
}

export const __testing = { noveltyKernel, sampleSpread, zeros };
