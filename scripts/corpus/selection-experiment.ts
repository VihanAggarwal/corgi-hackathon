/**
 * Which duel-selection objective actually works. Track A diagnostic.
 *
 *   npx tsx scripts/corpus/selection-experiment.ts
 *
 * The textbook criterion for active learning on a logistic model is
 * p(1-p) * d^T Sigma d. Implemented directly it lost to random pairing, so this
 * measures the candidate objectives against a simulated user instead of
 * assuming the textbook answer transfers.
 */

import { AXIS_COUNT } from '../../contracts/axes';
import { fitTheta, type FitObservation } from '../../core/model';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function cosine(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < AXIS_COUNT; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const sig = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Sparse truth: strong opinions on 4 axes, indifference on the other 20. */
function truth(): number[] {
  const t = new Array(AXIS_COUNT).fill(0);
  t[0] = 2.0;
  t[4] = -2.4;
  t[9] = 1.6;
  t[21] = -1.2;
  return t;
}

interface D {
  id: string;
  phi: number[];
}

function pool(size: number, seed: number): D[] {
  const rand = rng(seed);
  return Array.from({ length: size }, (_, i) => ({
    id: `d${i}`,
    phi: Array.from({ length: AXIS_COUNT }, () => (rand() - 0.5) * 4),
  }));
}

type Scorer = (d: number[], theta: number[], variance: number[]) => number;

const SCORERS: Record<string, Scorer | null> = {
  random: null,

  // The textbook criterion. Loses, and the reason is instructive.
  'p(1-p) * dSigmad': (d, theta, variance) => {
    let z = 0;
    let w = 0;
    for (let i = 0; i < AXIS_COUNT; i++) {
      z += theta[i] * d[i];
      w += variance[i] * d[i] * d[i];
    }
    const p = sig(z);
    return p * (1 - p) * w;
  },

  // Same, without variance weighting.
  'p(1-p) * |d|^2': (d, theta) => {
    let z = 0;
    let w = 0;
    for (let i = 0; i < AXIS_COUNT; i++) {
      z += theta[i] * d[i];
      w += d[i] * d[i];
    }
    const p = sig(z);
    return p * (1 - p) * w;
  },

  // Pure spread: the most different pair available, ignoring predictability.
  '|d|^2': (d) => {
    let w = 0;
    for (let i = 0; i < AXIS_COUNT; i++) w += d[i] * d[i];
    return w;
  },

  // Spread, but discourage pairs whose outcome is already near-certain.
  '|d|^2, certainty-capped': (d, theta) => {
    let z = 0;
    let w = 0;
    for (let i = 0; i < AXIS_COUNT; i++) {
      z += theta[i] * d[i];
      w += d[i] * d[i];
    }
    const p = sig(z);
    // Full credit until the outcome is beyond ~85% predictable, then fall off.
    const conf = Math.abs(p - 0.5) * 2;
    return w * (conf < 0.7 ? 1 : Math.max(0, 1 - (conf - 0.7) / 0.3));
  },
};

function run(name: string, scorer: Scorer | null, duels: number, trials: number): number {
  const T = truth();
  let sum = 0;

  for (let trial = 0; trial < trials; trial++) {
    const p = pool(300, trial * 131 + 3);
    const rand = rng(trial * 977 + 11);
    const obs: FitObservation[] = [];
    const used = new Set<string>();

    const answer = (a: D, b: D) => {
      let z = 0;
      for (let i = 0; i < AXIS_COUNT; i++) z += T[i] * (a.phi[i] - b.phi[i]);
      const aWins = rand() < sig(z);
      obs.push({ winnerPhi: aWins ? a.phi : b.phi, loserPhi: aWins ? b.phi : a.phi });
    };

    for (let k = 0; k < duels; k++) {
      if (!scorer) {
        const a = p[Math.floor(rand() * p.length)];
        const b = p[Math.floor(rand() * p.length)];
        if (a.id !== b.id) answer(a, b);
        continue;
      }

      const fit = fitTheta(obs, { lambda: 6 });
      let best: { a: D; b: D; s: number } | null = null;

      // Sample candidate pairs. Randomized per call, unlike a fixed hash.
      for (let t = 0; t < 400; t++) {
        const a = p[Math.floor(rand() * p.length)];
        const b = p[Math.floor(rand() * p.length)];
        if (a.id === b.id || used.has(a.id) || used.has(b.id)) continue;
        const d = new Array(AXIS_COUNT);
        for (let i = 0; i < AXIS_COUNT; i++) d[i] = a.phi[i] - b.phi[i];
        const s = scorer(d, fit.theta, fit.axisVariance);
        if (!best || s > best.s) best = { a, b, s };
      }

      if (!best) break;
      used.add(best.a.id);
      used.add(best.b.id);
      answer(best.a, best.b);
    }

    sum += cosine(fitTheta(obs, { lambda: 6 }).theta, T);
  }

  return sum / trials;
}

const TRIALS = 30;
console.log('\nCosine to a SPARSE truth (4 of 24 axes non-zero). Mean over 30 seeds.\n');
console.log('  objective                      10 duels   15 duels   30 duels');

for (const [name, scorer] of Object.entries(SCORERS)) {
  const r = [10, 15, 30].map((n) => run(name, scorer, n, TRIALS));
  console.log(
    `  ${name.padEnd(28)} ${r.map((x) => x.toFixed(3).padStart(8)).join('   ')}`,
  );
}
console.log('');
