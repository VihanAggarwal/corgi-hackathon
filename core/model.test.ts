/**
 * Bradley-Terry fit tests. Track A.
 *
 * The gate from the build spec: a synthetic user whose true theta we know must
 * be recovered in under 15 duels. Everything else here defends a property that,
 * if it broke silently, would produce plausible-looking wrong twins.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_COUNT } from '../contracts/axes';
import { CONSTANTS } from '../contracts/types';
import {
  fitTheta,
  isThetaStable,
  populationPrior,
  predictPreference,
  type FitObservation,
} from './model';

// ---------------------------------------------------------------------------
// Deterministic synthetic world
// ---------------------------------------------------------------------------

/** Seeded PRNG so a failure is reproducible rather than a flaky CI story. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomDish(rand: () => number): number[] {
  return Array.from({ length: AXIS_COUNT }, () => (rand() - 0.5) * 4);
}

/**
 * Generate duels from a known theta. The synthetic user is NOT deterministic:
 * they pick probabilistically per Bradley-Terry, which is the realistic case and
 * a much harder test than an argmax user.
 */
function duelsFrom(trueTheta: number[], count: number, seed = 7): FitObservation[] {
  const rand = rng(seed);
  const out: FitObservation[] = [];
  for (let i = 0; i < count; i++) {
    const a = randomDish(rand);
    const b = randomDish(rand);
    let z = 0;
    for (let j = 0; j < AXIS_COUNT; j++) z += trueTheta[j] * (a[j] - b[j]);
    const pA = 1 / (1 + Math.exp(-z));
    const aWins = rand() < pA;
    out.push({ winnerPhi: aWins ? a : b, loserPhi: aWins ? b : a });
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < AXIS_COUNT; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** A user with a few strong opinions and indifference elsewhere. Realistic. */
function sparseTheta(): number[] {
  const t = new Array(AXIS_COUNT).fill(0);
  t[0] = 2.0; // loves chili heat
  t[4] = -2.4; // rejects sweetness in savory food
  t[9] = 1.6; // seeks funk
  t[21] = -1.2; // adventurous about ingredients
  return t;
}

// ---------------------------------------------------------------------------

describe('fitTheta', () => {
  it('recovers the direction of a known theta in under 15 duels', () => {
    const truth = sparseTheta();
    const fit = fitTheta(duelsFrom(truth, 14), { lambda: 6 });

    expect(fit.nComparisons).toBe(14);
    // Direction is what matters: magnitude is deliberately shrunk at low n.
    expect(cosine(fit.theta, truth)).toBeGreaterThan(0.6);
  });

  it('gets monotonically closer to the truth as duels accumulate', () => {
    const truth = sparseTheta();
    const at = (n: number) => cosine(fitTheta(duelsFrom(truth, n), { lambda: 6 }).theta, truth);

    const early = at(10);
    const mid = at(40);
    const late = at(150);

    expect(mid).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(mid);
    expect(late).toBeGreaterThan(0.9);
  });

  it('ranks the strongest true axes among its own strongest', () => {
    const truth = sparseTheta();
    const fit = fitTheta(duelsFrom(truth, 80), { lambda: 6 });

    const topFitted = fit.theta
      .map((v, i) => ({ i, m: Math.abs(v) }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 4)
      .map((x) => x.i);

    // The two loudest true opinions must surface. These are the axes the
    // renderer will speak out loud, so getting them wrong is a visible failure.
    expect(topFitted).toContain(4);
    expect(topFitted).toContain(0);
  });

  // -------------------------------------------------------------------------
  // Shrinkage: the property that stops early users getting exotic twins
  // -------------------------------------------------------------------------

  it('keeps a 12-duel user close to the prior', () => {
    const truth = sparseTheta();
    const few = fitTheta(duelsFrom(truth, 12));
    const many = fitTheta(duelsFrom(truth, 200));

    const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

    // Not "somewhat smaller": a low-n user must be dramatically less extreme,
    // because extremity is what produces a confident wrong twin match.
    expect(norm(few.theta)).toBeLessThan(norm(many.theta) * 0.6);
  });

  it('returns exactly the prior when there are no duels', () => {
    const prior = new Array(AXIS_COUNT).fill(0.3);
    const fit = fitTheta([], { prior });

    expect(fit.theta).toEqual(prior);
    expect(fit.nComparisons).toBe(0);
    expect(isThetaStable(fit)).toBe(false);
  });

  it('shrinks toward a non-zero population prior, not toward zero', () => {
    const prior = new Array(AXIS_COUNT).fill(0);
    prior[7] = 1.5; // population skews toward savory depth

    const truth = sparseTheta();
    const fit = fitTheta(duelsFrom(truth, 8), { prior, lambda: 40 });

    // With 8 duels against lambda 40 the user is mostly prior, so the
    // population's opinion on axis 7 should still be visible.
    expect(fit.theta[7]).toBeGreaterThan(0.7);
  });

  // -------------------------------------------------------------------------
  // Masking: hard rule on unreliable extraction
  // -------------------------------------------------------------------------

  it('ignores masked axes entirely', () => {
    const rand = rng(3);
    const observations: FitObservation[] = [];
    for (let i = 0; i < 60; i++) {
      const a = randomDish(rand);
      const b = randomDish(rand);
      // Axis 3 is masked but carries a large, consistent, fake difference. If
      // masking leaks, the fit will confidently learn an axis nobody measured.
      a[3] = 3;
      b[3] = -3;
      observations.push({ winnerPhi: a, loserPhi: b, maskedIdx: [3] });
    }
    const fit = fitTheta(observations, { lambda: 6 });
    expect(Math.abs(fit.theta[3])).toBeLessThan(0.05);
  });

  // -------------------------------------------------------------------------
  // Posterior variance
  // -------------------------------------------------------------------------

  it('reports lower posterior variance as evidence accumulates', () => {
    const truth = sparseTheta();
    expect(fitTheta(duelsFrom(truth, 100)).posteriorVar).toBeLessThan(
      fitTheta(duelsFrom(truth, 10)).posteriorVar,
    );
  });

  it('does not call a 5-duel user stable', () => {
    const fit = fitTheta(duelsFrom(sparseTheta(), 5));
    expect(fit.nComparisons).toBeLessThan(CONSTANTS.MIN_DUELS_FOR_THETA);
    expect(isThetaStable(fit)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Step-size stability. This caught a real divergence, keep it.
  // -------------------------------------------------------------------------

  it('stays bounded at very low n, where the ridge term is largest', () => {
    // ridge = lambda / n, so n = 1 is the worst case for step stability. With a
    // fixed learning rate this produced |theta| ~ 1e16 rather than a number.
    const truth = sparseTheta();
    for (const n of [1, 2, 3, 5]) {
      for (const lambda of [6, 25, 100]) {
        const fit = fitTheta(duelsFrom(truth, n), { lambda });
        const mag = Math.sqrt(fit.theta.reduce((s, x) => s + x * x, 0));
        expect(Number.isFinite(mag)).toBe(true);
        // A handful of duels can never justify a large vector.
        expect(mag).toBeLessThan(3);
      }
    }
  });

  it('does not diverge on large difference vectors', () => {
    // Extreme dishes make |d|^2 large, which raises the curvature bound.
    const big = new Array(AXIS_COUNT).fill(3);
    const small = new Array(AXIS_COUNT).fill(-3);
    const fit = fitTheta([{ winnerPhi: big, loserPhi: small }], { lambda: 25 });
    expect(fit.theta.every((v) => Number.isFinite(v) && Math.abs(v) < 3)).toBe(true);
  });

  it('produces finite values on degenerate input', () => {
    // Two identical dishes: zero difference vector, zero information.
    const flat = new Array(AXIS_COUNT).fill(1);
    const fit = fitTheta([{ winnerPhi: flat, loserPhi: [...flat] }]);
    expect(fit.theta.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(fit.posteriorVar)).toBe(true);
  });
});

describe('predictPreference', () => {
  it('is symmetric around 0.5', () => {
    const theta = sparseTheta();
    const rand = rng(11);
    const a = randomDish(rand);
    const b = randomDish(rand);
    expect(predictPreference(theta, a, b) + predictPreference(theta, b, a)).toBeCloseTo(1, 10);
  });

  it('returns 0.5 for identical dishes', () => {
    const d = new Array(AXIS_COUNT).fill(0.5);
    expect(predictPreference(sparseTheta(), d, [...d])).toBeCloseTo(0.5, 10);
  });

  it('prefers the dish aligned with the user', () => {
    const theta = new Array(AXIS_COUNT).fill(0);
    theta[0] = 2;
    const hot = new Array(AXIS_COUNT).fill(0);
    hot[0] = 2;
    const mild = new Array(AXIS_COUNT).fill(0);
    mild[0] = -2;
    expect(predictPreference(theta, hot, mild)).toBeGreaterThan(0.9);
  });
});

describe('populationPrior', () => {
  it('averages fitted users', () => {
    const a = new Array(AXIS_COUNT).fill(1);
    const b = new Array(AXIS_COUNT).fill(3);
    expect(populationPrior([a, b])[0]).toBeCloseTo(2, 10);
  });

  it('is the zero vector with no population', () => {
    expect(populationPrior([])).toEqual(new Array(AXIS_COUNT).fill(0));
  });
});
