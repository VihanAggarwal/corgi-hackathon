/**
 * Bradley-Terry preference fitting. Track A.
 *
 * A duel is a pairwise comparison, so the natural model is Bradley-Terry:
 *
 *     P(winner beats loser) = sigmoid(theta . (phi_win - phi_lose))
 *
 * which is logistic regression on the vector DIFFERENCE, with no intercept.
 * Fit by gradient descent. No ML library: the whole thing is ~80 lines and a
 * dependency here would be heavier than the math.
 *
 * WHY PAIRWISE RATHER THAN RATINGS
 * Star ratings are not comparable across people. One person's 4 is another's 2,
 * and the difference is personality, not taste. A pairwise choice has no scale
 * to calibrate, so it carries strictly more signal per unit of user effort.
 *
 * SHRINKAGE IS THE LOAD-BEARING PART
 * A user with 12 duels has almost no information, and an unshrunk fit on 12
 * points produces a confident, extreme, wrong theta. That user then gets matched
 * to exotic twins on the basis of noise, which is the single worst failure this
 * product can have: it is unfalsifiable to the user and it poisons their whole
 * experience. So theta is pulled toward the population prior with strength
 * inversely proportional to n, and early users are mostly prior by construction.
 *
 * Hard rule 7: fitting happens ONLY on duels where both dishes are verified.
 */

import { AXIS_COUNT } from '../contracts/axes';
import { CONSTANTS, type UserVector, type Vec24 } from '../contracts/types';

export interface FitObservation {
  /** phi of the chosen dish. Must be a verified dish (hard rule 7). */
  winnerPhi: Vec24;
  /** phi of the rejected dish. Must be a verified dish. */
  loserPhi: Vec24;
  /**
   * Axes masked on EITHER dish. A masked axis contributes no gradient, because
   * the difference on that axis is not evidence, it is absence of evidence.
   */
  maskedIdx?: number[];
}

export interface FitOptions {
  /** Population mean theta. Zero vector when there is no population yet. */
  prior?: Vec24;
  /**
   * Shrinkage strength. theta is pulled toward the prior with weight
   * lambda / (lambda + n). At the default, 12 duels leaves a user ~68% prior
   * and 60 duels leaves them ~30% prior.
   */
  lambda?: number;
  iterations?: number;
  learningRate?: number;
}

const DEFAULTS: Required<Omit<FitOptions, 'prior'>> = {
  lambda: 25,
  iterations: 400,
  learningRate: 0.35,
};

function zeros(): number[] {
  return new Array(AXIS_COUNT).fill(0);
}

function sigmoid(z: number): number {
  // Numerically stable both ways.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < AXIS_COUNT; i++) s += a[i] * b[i];
  return s;
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

export interface FitResult extends UserVector {
  /** Per-axis posterior variance, for callers that need to know which axes are known. */
  axisVariance: number[];
}

/**
 * Fit theta from duels.
 *
 * Every observation is the difference vector d = phi_win - phi_lose with label
 * 1. Rather than also adding the mirrored (-d, label 0) example, which is the
 * same constraint written twice, we optimize the log-likelihood of d directly.
 */
export function fitTheta(observations: FitObservation[], options: FitOptions = {}): FitResult {
  const { lambda, iterations, learningRate } = { ...DEFAULTS, ...options };
  const prior = options.prior ?? zeros();
  const n = observations.length;

  // Precompute difference vectors and their active-axis masks once.
  const diffs: number[][] = [];
  const actives: boolean[][] = [];
  for (const o of observations) {
    const d = zeros();
    const active = new Array<boolean>(AXIS_COUNT).fill(true);
    if (o.maskedIdx) for (const i of o.maskedIdx) active[i] = false;
    for (let i = 0; i < AXIS_COUNT; i++) {
      d[i] = active[i] ? o.winnerPhi[i] - o.loserPhi[i] : 0;
    }
    diffs.push(d);
    actives.push(active);
  }

  // Raw MLE-ish fit with L2 toward the prior built into the gradient.
  const theta = [...prior];
  if (n > 0) {
    // Ridge strength per observation keeps the penalty scale-free in n.
    const ridge = lambda / Math.max(n, 1);
    for (let iter = 0; iter < iterations; iter++) {
      const grad = zeros();
      for (let k = 0; k < n; k++) {
        const d = diffs[k];
        const p = sigmoid(dot(theta, d));
        // d(log-likelihood)/d(theta) for label 1 is (1 - p) * d
        const w = 1 - p;
        for (let i = 0; i < AXIS_COUNT; i++) grad[i] += w * d[i];
      }
      for (let i = 0; i < AXIS_COUNT; i++) {
        // Average gradient, minus the pull toward the prior.
        const g = grad[i] / n - ridge * (theta[i] - prior[i]);
        theta[i] += learningRate * g;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shrinkage toward the prior.
  //
  // Applied AFTER fitting rather than only as a ridge term, because the ridge
  // controls the optimum while this controls what we are willing to CLAIM. A
  // user with few duels should be reported as close to average, whatever the
  // optimizer found.
  // ---------------------------------------------------------------------------
  const shrink = n / (n + lambda);
  const shrunk: Vec24 = theta.map((t, i) => prior[i] + shrink * (t - prior[i]));

  // ---------------------------------------------------------------------------
  // Posterior variance.
  //
  // Laplace approximation: the Hessian of the logistic log-likelihood is
  // sum_k p_k (1 - p_k) d_k d_k^T. We keep only the diagonal, which is all a
  // caller needs to ask "is this axis known yet", and add the prior precision.
  // ---------------------------------------------------------------------------
  const fisher = zeros();
  for (let k = 0; k < n; k++) {
    const d = diffs[k];
    const p = sigmoid(dot(shrunk, d));
    const v = p * (1 - p);
    for (let i = 0; i < AXIS_COUNT; i++) fisher[i] += v * d[i] * d[i];
  }
  // Prior precision is lambda: with no data, variance is 1/lambda, not infinite.
  const axisVariance = fisher.map((f) => 1 / (f + lambda / 10));
  const posteriorVar = axisVariance.reduce((s, v) => s + v, 0) / AXIS_COUNT;

  return {
    theta: shrunk,
    nComparisons: n,
    posteriorVar,
    axisVariance,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Whether a fitted vector is stable enough to act on.
 *
 * Both gates matter: posteriorVar alone can look good on a user who happened to
 * see extreme dishes, and n alone says nothing about whether those duels were
 * informative.
 */
export function isThetaStable(v: Pick<UserVector, 'nComparisons' | 'posteriorVar'>): boolean {
  return (
    v.nComparisons >= CONSTANTS.MIN_DUELS_FOR_THETA &&
    v.posteriorVar <= CONSTANTS.THETA_STABLE_VAR
  );
}

/** Predicted probability the user prefers dish A over dish B. */
export function predictPreference(theta: Vec24, phiA: Vec24, phiB: Vec24): number {
  const d = zeros();
  for (let i = 0; i < AXIS_COUNT; i++) d[i] = phiA[i] - phiB[i];
  return sigmoid(dot(theta, d));
}

/** Population prior: the mean of every fitted user. Zero vector when empty. */
export function populationPrior(thetas: Vec24[]): Vec24 {
  if (thetas.length === 0) return zeros();
  const sum = zeros();
  for (const t of thetas) for (let i = 0; i < AXIS_COUNT; i++) sum[i] += t[i];
  return sum.map((s) => s / thetas.length);
}

export const __testing = { sigmoid, dot, zeros };
