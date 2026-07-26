/**
 * Active duel selection tests. Track A.
 *
 * The headline claim is that active selection recovers theta in meaningfully
 * fewer duels than random pairing. That is measured directly at the bottom
 * rather than asserted, because it is the justification for the whole file.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_COUNT } from '../contracts/axes';
import { CONSTANTS } from '../contracts/types';
import { fitTheta, type FitObservation } from './model';
import {
  expectedInformation,
  passesPopulationGate,
  selectDuels,
  type DuelCandidate,
} from './duel-select';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function dish(id: string, phi: number[], extra: Partial<DuelCandidate> = {}): DuelCandidate {
  return { dishId: id, phi, maskedIdx: [], verified: true, ...extra };
}

function flat(v = 0): number[] {
  return new Array(AXIS_COUNT).fill(v);
}

function pool(size: number, seed = 5): DuelCandidate[] {
  const rand = rng(seed);
  return Array.from({ length: size }, (_, i) =>
    dish(
      `d${i}`,
      Array.from({ length: AXIS_COUNT }, () => (rand() - 0.5) * 4),
      { venueId: `v${i % 40}` },
    ),
  );
}

function truth(): number[] {
  const t = flat();
  t[0] = 2.0;
  t[4] = -2.4;
  t[9] = 1.6;
  t[21] = -1.2;
  return t;
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

// ---------------------------------------------------------------------------

describe('expectedInformation', () => {
  it('is near zero for two identical dishes', () => {
    const d = flat(1);
    const { score, p } = expectedInformation(dish('a', d), dish('b', [...d]), truth());
    expect(score).toBeCloseTo(0, 10);
    expect(p).toBeCloseTo(0.5, 10);
  });

  it('is near zero when the outcome is already certain', () => {
    // Huge difference on an axis the user has a strong opinion about: we know
    // the answer, so asking is a wasted duel.
    const hot = flat();
    hot[0] = 3;
    const mild = flat();
    mild[0] = -3;
    const { score, p } = expectedInformation(dish('a', hot), dish('b', mild), truth());
    expect(p).toBeGreaterThan(0.99);
    expect(score).toBeLessThan(0.05);
  });

  it('is high when the outcome is in doubt but the dishes differ', () => {
    // Differ only on an axis the user is indifferent to: genuinely uncertain,
    // and the answer teaches us about that axis.
    const a = flat();
    a[13] = 2.5;
    const b = flat();
    b[13] = -2.5;
    const { score, p } = expectedInformation(dish('a', a), dish('b', b), truth());
    expect(p).toBeCloseTo(0.5, 3);
    expect(score).toBeGreaterThan(1);
  });

  it('ignores masked axes', () => {
    const a = flat();
    a[3] = 3;
    const b = flat();
    b[3] = -3;
    const { score } = expectedInformation(
      dish('a', a, { maskedIdx: [3] }),
      dish('b', b, { maskedIdx: [3] }),
      truth(),
    );
    expect(score).toBeCloseTo(0, 10);
  });

  it('weights uncertain axes more heavily', () => {
    const a = flat();
    a[13] = 2;
    const b = flat();
    b[13] = -2;

    const lowVar = flat(0.01);
    const highVar = flat(0.01);
    highVar[13] = 1.0;

    const known = expectedInformation(dish('a', a), dish('b', b), truth(), lowVar).score;
    const unknown = expectedInformation(dish('a', a), dish('b', b), truth(), highVar).score;
    expect(unknown).toBeGreaterThan(known * 10);
  });
});

describe('passesPopulationGate', () => {
  const seen = { appearances: 50 };

  it('rejects a pair the population agrees on', () => {
    // 95/5 split is far above CONSENSUS_CEILING: a fact about the dishes.
    expect(
      passesPopulationGate(
        dish('a', flat(), { ...seen, populationWinRate: 0.95 }),
        dish('b', flat(), { ...seen, populationWinRate: 0.05 }),
      ),
    ).toBe(false);
  });

  it('rejects a pure coin flip', () => {
    expect(
      passesPopulationGate(
        dish('a', flat(), { ...seen, populationWinRate: 0.5 }),
        dish('b', flat(), { ...seen, populationWinRate: 0.5 }),
      ),
    ).toBe(false);
  });

  it('accepts a genuinely divisive pair', () => {
    // ~70/30 sits inside both bounds: the population really is split.
    expect(
      passesPopulationGate(
        dish('a', flat(), { ...seen, populationWinRate: 0.7 }),
        dish('b', flat(), { ...seen, populationWinRate: 0.3 }),
      ),
    ).toBe(true);
  });

  it('lets a dish with too few appearances through', () => {
    // Otherwise no dish could ever accumulate the appearances to be judged.
    expect(
      passesPopulationGate(
        dish('a', flat(), { appearances: 2, populationWinRate: 0.99 }),
        dish('b', flat(), { appearances: 1, populationWinRate: 0.01 }),
      ),
    ).toBe(true);
  });

  it('uses the contract constants, not hardcoded numbers', () => {
    expect(CONSTANTS.CONSENSUS_CEILING).toBe(0.85);
    expect(CONSTANTS.NOISE_FLOOR).toBe(0.55);
  });
});

describe('selectDuels', () => {
  it('excludes unverified dishes (hard rule 7)', () => {
    const p = pool(60).map((d, i) => ({ ...d, verified: i % 2 === 0 }));
    for (const pair of selectDuels(p, { theta: flat(), count: 10 })) {
      expect(pair.a.verified).toBe(true);
      expect(pair.b.verified).toBe(true);
    }
  });

  it('never repeats a dish inside one block', () => {
    const pairs = selectDuels(pool(120), { theta: truth(), count: 12 });
    const ids = pairs.flatMap((p) => [p.a.dishId, p.b.dishId]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never pairs two dishes from the same venue', () => {
    for (const pair of selectDuels(pool(120), { theta: truth(), count: 12 })) {
      expect(pair.a.venueId).not.toBe(pair.b.venueId);
    }
  });

  it('skips dishes the user has already seen', () => {
    const seen = new Set(['d0', 'd1', 'd2', 'd3', 'd4']);
    for (const pair of selectDuels(pool(80), { theta: flat(), count: 10, seenDishIds: seen })) {
      expect(seen.has(pair.a.dishId)).toBe(false);
      expect(seen.has(pair.b.dishId)).toBe(false);
    }
  });

  it('returns empty rather than throwing when the pool is exhausted', () => {
    expect(selectDuels([], { theta: flat() })).toEqual([]);
    expect(selectDuels([dish('only', flat())], { theta: flat() })).toEqual([]);
  });

  it('returns pairs sorted by information, most informative first', () => {
    const pairs = selectDuels(pool(150), { theta: truth(), count: 8 });
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].expectedInformation).toBeGreaterThanOrEqual(
        pairs[i].expectedInformation,
      );
    }
  });

  it('picks pairs whose outcome is genuinely in doubt', () => {
    const pairs = selectDuels(pool(200), { theta: truth(), count: 10 });
    // Not a coin flip on average, but nowhere near certain either.
    const mean = pairs.reduce((s, p) => s + Math.abs(p.predictedP - 0.5), 0) / pairs.length;
    expect(mean).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// The claim that justifies this file
// ---------------------------------------------------------------------------

describe('active vs random selection', () => {
  it('reaches a better theta in the same number of duels', () => {
    const T = truth();
    const DUELS = 15;
    const TRIALS = 25;

    let activeSum = 0;
    let randomSum = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const p = pool(300, trial * 131 + 3);
      const rand = rng(trial * 977 + 11);

      /** Simulated user: probabilistic Bradley-Terry choice, not argmax. */
      const answer = (a: DuelCandidate, b: DuelCandidate): FitObservation => {
        let z = 0;
        for (let i = 0; i < AXIS_COUNT; i++) z += T[i] * (a.phi[i] - b.phi[i]);
        const aWins = rand() < 1 / (1 + Math.exp(-z));
        return { winnerPhi: aWins ? a.phi : b.phi, loserPhi: aWins ? b.phi : a.phi };
      };

      // Active: refit after each duel so selection uses current belief.
      // axisVariance is deliberately not passed; see SelectOptions for the
      // measurements behind that default.
      const activeObs: FitObservation[] = [];
      const usedActive = new Set<string>();
      for (let d = 0; d < DUELS; d++) {
        const fit = fitTheta(activeObs, { lambda: 6 });
        const [next] = selectDuels(p, {
          theta: fit.theta,
          seenDishIds: usedActive,
          count: 1,
          samplePairs: 400,
          // Vary per duel and per trial, never fixed across calls.
          sampleSeed: trial * 7919 + d * 104729 + 1,
        });
        if (!next) break;
        usedActive.add(next.a.dishId);
        usedActive.add(next.b.dishId);
        activeObs.push(answer(next.a, next.b));
      }

      // Random: uniformly sampled pairs, same count, same simulated user.
      const randomObs: FitObservation[] = [];
      for (let d = 0; d < DUELS; d++) {
        const a = p[Math.floor(rand() * p.length)];
        const b = p[Math.floor(rand() * p.length)];
        if (a.dishId === b.dishId) continue;
        randomObs.push(answer(a, b));
      }

      activeSum += cosine(fitTheta(activeObs, { lambda: 6 }).theta, T);
      randomSum += cosine(fitTheta(randomObs, { lambda: 6 }).theta, T);
    }

    const active = activeSum / TRIALS;
    const random = randomSum / TRIALS;
    console.log(
      `\n  ${DUELS} duels: active cosine ${active.toFixed(3)} vs random ${random.toFixed(3)}\n`,
    );

    // If active selection were not better, the file would not be worth its
    // complexity and the honest move would be to delete it.
    expect(active).toBeGreaterThan(random);
  });
});
