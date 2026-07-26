/**
 * Lift gate tests. Track A.
 *
 * The claim being defended is narrow and absolute: a dish everyone likes cannot
 * reach the twin channel, and a dish four people liked cannot reach it either.
 * Most of this file is spent trying to get such a dish through the gate by
 * every route the input allows, including sweeps rather than single examples,
 * because one hand-picked passing case proves very little about a gate.
 */

import { describe, expect, it } from 'vitest';
import { CONSTANTS } from '../contracts/types';
import {
  computeLift,
  evaluateLift,
  isBillboard,
  LIFT_TUNING,
  populationBaseline,
  shrunkTwinRate,
  twinSupportForPacket,
  type LiftDecision,
  type LiftInput,
} from './lift';

/** Population counts hitting a target rate exactly, with a trustworthy n. */
function pop(rate: number, n = 400): { n: number; positive: number } {
  const positive = Math.round(rate * n);
  return { n, positive };
}

function decide(twin: { n: number; positive: number }, population: LiftInput['population']) {
  return evaluateLift({ twin, population });
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------

describe('constants the gate depends on', () => {
  it('uses the contract values, not local copies', () => {
    expect(CONSTANTS.LIFT_DELTA).toBe(0.15);
    expect(CONSTANTS.K_FLOOR).toBe(5);
  });

  it('places the billboard bound exactly on the consensus ceiling', () => {
    // If these two ever disagree, an item excluded from duel selection for being
    // universal could still be spoken about as a twin discovery, or vice versa.
    expect(1 - CONSTANTS.LIFT_DELTA).toBe(CONSTANTS.CONSENSUS_CEILING);
  });
});

describe('shrunkTwinRate', () => {
  it('does not report 2 out of 2 as 100 percent', () => {
    // (2 + 5 * 0.30) / (2 + 5) = 0.5. Two data points are two data points.
    expect(shrunkTwinRate(2, 2, 0.3)).toBeCloseTo(0.5, 12);
    expect(shrunkTwinRate(2, 2, 0.3)).toBeLessThan(1);
  });

  it('never reaches 1 for any finite unanimous sample', () => {
    for (const n of [1, 5, 20, 100, 5000]) {
      expect(shrunkTwinRate(n, n, 0.3)).toBeLessThan(1);
    }
  });

  it('sits between the raw rate and the population rate', () => {
    const raw = 6 / 8;
    const est = shrunkTwinRate(6, 8, 0.2);
    expect(est).toBeLessThan(raw);
    expect(est).toBeGreaterThan(0.2);
  });

  it('converges to the raw rate as the sample grows', () => {
    const small = shrunkTwinRate(6, 8, 0.2);
    const large = shrunkTwinRate(600, 800, 0.2);
    expect(Math.abs(large - 0.75)).toBeLessThan(Math.abs(small - 0.75));
    expect(large).toBeCloseTo(0.75, 2);
  });

  it('returns the population rate exactly when there are no twin observations', () => {
    // No twins have eaten it, so the honest estimate is "same as everyone".
    expect(shrunkTwinRate(0, 0, 0.42)).toBeCloseTo(0.42, 12);
  });
});

describe('computeLift', () => {
  it('is near zero when twins behave like the population', () => {
    expect(computeLift({ n: 200, positive: 60 }, pop(0.3))).toBeCloseTo(0, 2);
  });

  it('is negative when twins like it less than the room', () => {
    expect(computeLift({ n: 40, positive: 4 }, pop(0.6))).toBeLessThan(0);
  });

  it('rejects impossible counts rather than producing a rate above 1', () => {
    expect(() => computeLift({ n: 3, positive: 5 }, pop(0.3))).toThrow(/exceeds total/);
    expect(() => computeLift({ n: -1, positive: 0 }, pop(0.3))).toThrow(/negative/);
    expect(() => computeLift({ n: 2.5, positive: 1 }, pop(0.3))).toThrow(/integers/);
    expect(() => computeLift({ n: 5, positive: 2 }, { n: 10, positive: 11 })).toThrow(
      /population/,
    );
  });
});

// ---------------------------------------------------------------------------
// The billboard case: this must be impossible, not merely unlikely
// ---------------------------------------------------------------------------

describe('a universally loved dish', () => {
  const population = pop(0.95); // 380 of 400

  it('fails the gate at population 0.95 with twins at 0.97', () => {
    const d = decide({ n: 100, positive: 97 }, population);
    expect(d.channel).toBe('content');
    expect(d.reason).toBe('universally_liked');
    expect(d.evidence.lift).toBeLessThan(CONSTANTS.LIFT_DELTA);
  });

  it('cannot be forced through by any twin sample', () => {
    // Unanimous twins, every cluster size from the k floor to a corpus-sized
    // crowd. The bound is arithmetic, so none of these may pass.
    for (let n = CONSTANTS.K_FLOOR; n <= 2000; n++) {
      const d = decide({ n, positive: n }, population);
      expect(d.channel).toBe('content');
    }
  });

  it('cannot be forced through at any population rate above the ceiling', () => {
    for (const rate of [0.85, 0.86, 0.9, 0.95, 0.99, 1.0]) {
      expect(isBillboard(rate)).toBe(true);
      const d = decide({ n: 500, positive: 500 }, pop(rate, 1000));
      expect(d.channel).toBe('content');
      expect(d.reason).toBe('universally_liked');
      expect(d.evidence.maxPossibleLift).toBeLessThanOrEqual(CONSTANTS.LIFT_DELTA + 1e-12);
    }
  });

  it('is not classified as a billboard just below the ceiling', () => {
    // Guards against the bound creeping down and silencing real divergence.
    expect(isBillboard(0.84)).toBe(false);
    expect(isBillboard(0.5)).toBe(false);
  });

  it('still gets a content channel with the room baseline attached', () => {
    const d = evaluateLift({
      twin: { n: 100, positive: 97 },
      population,
      venueOrders: [
        { dishName: 'soup dumplings', orders: 210 },
        { dishName: 'wood ear salad', orders: 40 },
      ],
    });
    expect(d.channel).toBe('content');
    // The divergence sentence stays available even when twins are refused.
    expect(d.evidence.populationBaseline?.topDishName).toBe('soup dumplings');
  });
});

// ---------------------------------------------------------------------------
// The case the product exists for
// ---------------------------------------------------------------------------

describe('a genuinely divergent dish', () => {
  it('passes at population 0.30 with twins at 0.75', () => {
    const d = decide({ n: 12, positive: 9 }, pop(0.3));
    expect(d.channel).toBe('twin');
    expect(d.reason).toBe('twin_support_diverges_from_population');
    expect(d.evidence.lift).toBeGreaterThan(CONSTANTS.LIFT_DELTA);
    expect(d.evidence.k).toBe(9);
    expect(d.evidence.kFloorMet).toBe(true);
  });

  it('reports the room baseline alongside the twin verdict', () => {
    const d = evaluateLift({
      twin: { n: 12, positive: 9 },
      population: pop(0.3),
      venueOrders: [
        { dishName: 'noodles', orders: 61 },
        { dishName: 'liang pi', orders: 22 },
        { dishName: 'cumin lamb', orders: 17 },
      ],
    });
    expect(d.channel).toBe('twin');
    expect(d.evidence.populationBaseline).toEqual({
      topDishName: 'noodles',
      topDishShare: 61 / 100,
    });
  });
});

// ---------------------------------------------------------------------------
// The k floor
// ---------------------------------------------------------------------------

describe('the k floor', () => {
  // Population almost nobody likes, so lift is enormous and only k can stop it.
  const rare = pop(0.05, 200);

  it('refuses four supporters despite an enormous lift', () => {
    const d = decide({ n: 6, positive: 4 }, rare);
    expect(d.evidence.lift).toBeGreaterThan(0.3);
    expect(d.channel).toBe('content');
    expect(d.reason).toBe('k_floor_not_met');
    expect(d.evidence.kFloorMet).toBe(false);
  });

  it('admits the same dish at five supporters', () => {
    // Proves the previous case failed on k and not on some other floor.
    const d = decide({ n: 7, positive: 5 }, rare);
    expect(d.channel).toBe('twin');
    expect(d.evidence.k).toBe(CONSTANTS.K_FLOOR);
  });

  it('counts supporters, not observations', () => {
    // Forty twins ate it and five liked it. That is not five people vouching
    // for it against the room, that is a dish twins mostly disliked.
    const d = decide({ n: 40, positive: 5 }, rare);
    expect(d.evidence.kFloorMet).toBe(true);
    expect(d.channel).toBe('content');
    expect(d.reason).toBe('no_divergence_from_population');
  });
});

// ---------------------------------------------------------------------------
// Small-sample honesty
// ---------------------------------------------------------------------------

describe('thin evidence', () => {
  it('refuses two out of two and says which floor stopped it', () => {
    const d = decide({ n: 2, positive: 2 }, pop(0.3));
    expect(d.channel).toBe('content');
    expect(d.reason).toBe('not_enough_twin_observations');
    // The estimate itself was already honest: 0.5, not 1.0.
    expect(d.evidence.shrunkTwinRate).toBeCloseTo(0.5, 12);
    expect(d.evidence.rawTwinRate).toBe(1);
  });

  it('refuses every unanimous cluster below the observation floor', () => {
    for (let n = 0; n < LIFT_TUNING.MIN_TWIN_OBSERVATIONS; n++) {
      const d = decide({ n, positive: n }, pop(0.2));
      expect(d.channel).toBe('content');
      expect(d.reason).toBe('not_enough_twin_observations');
    }
  });

  it('refuses when the population baseline itself is a guess', () => {
    // Nineteen people is not a room. Lift against it is noise minus noise.
    const d = decide({ n: 20, positive: 18 }, { n: 19, positive: 2 });
    expect(d.channel).toBe('content');
    expect(d.reason).toBe('population_baseline_too_small');
  });

  it('reports the baseline problem before the twin problem', () => {
    // Both are true. The one that will not fix itself with more twins is the
    // one the caller needs to hear.
    const d = decide({ n: 1, positive: 1 }, { n: 3, positive: 0 });
    expect(d.reason).toBe('population_baseline_too_small');
  });

  it('does not let a modest edge through on the raw ratio', () => {
    // Five of thirteen against a population rate of 0.20 is a raw lift of 0.18,
    // over the delta, and the k floor is met. Shrinkage pulls it to 0.13,
    // because thirteen observations is not enough to claim a real gap that
    // small. The shrunk estimate is the one that decides.
    const population = pop(0.2, 200);
    expect(5 / 13 - 0.2).toBeGreaterThan(CONSTANTS.LIFT_DELTA);

    const d = decide({ n: 13, positive: 5 }, population);
    expect(d.evidence.kFloorMet).toBe(true);
    expect(d.evidence.lift).toBeCloseTo(0.1333, 4);
    expect(d.evidence.rawTwinRate - d.evidence.populationRate).toBeGreaterThan(
      CONSTANTS.LIFT_DELTA,
    );
    expect(d.channel).toBe('content');
    expect(d.reason).toBe('no_divergence_from_population');
  });
});

// ---------------------------------------------------------------------------
// The delta itself
// ---------------------------------------------------------------------------

describe('the lift delta', () => {
  const population = pop(0.2, 200);

  it('is the only thing separating two otherwise identical clusters', () => {
    // Same supporters, same population, one more indifferent twin in the
    // denominator. Everything else about these two calls is equal.
    const above = decide({ n: 14, positive: 6 }, population);
    const below = decide({ n: 16, positive: 6 }, population);

    expect(above.evidence.lift).toBeGreaterThan(CONSTANTS.LIFT_DELTA);
    expect(below.evidence.lift).toBeLessThan(CONSTANTS.LIFT_DELTA);
    expect(above.channel).toBe('twin');
    expect(below.channel).toBe('content');
    expect(below.reason).toBe('no_divergence_from_population');
  });

  it('refuses a dish twins like less than the room', () => {
    const d = decide({ n: 30, positive: 6 }, pop(0.6));
    expect(d.evidence.lift).toBeLessThan(0);
    expect(d.channel).toBe('content');
    expect(d.reason).toBe('no_divergence_from_population');
  });
});

// ---------------------------------------------------------------------------
// The content channel is never taken away
// ---------------------------------------------------------------------------

describe('the content channel', () => {
  const refusals: Array<[string, LiftDecision]> = [
    ['universally liked', decide({ n: 100, positive: 97 }, pop(0.95))],
    ['k floor', decide({ n: 6, positive: 4 }, pop(0.05, 200))],
    ['thin twin sample', decide({ n: 2, positive: 2 }, pop(0.3))],
    ['thin population', decide({ n: 20, positive: 18 }, { n: 5, positive: 1 })],
    ['no divergence', decide({ n: 30, positive: 10 }, pop(0.3))],
  ];

  it('remains available for every refusal reason', () => {
    for (const [label, d] of refusals) {
      expect(d.channel, label).toBe('content');
    }
    // Every distinct reason is exercised above, so no refusal path is untested.
    expect(new Set(refusals.map(([, d]) => d.reason)).size).toBe(refusals.length);
  });

  it('still carries the numbers a content recommendation needs', () => {
    for (const [label, d] of refusals) {
      expect(Number.isFinite(d.evidence.lift), label).toBe(true);
      expect(Number.isFinite(d.evidence.populationRate), label).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Population baseline
// ---------------------------------------------------------------------------

describe('populationBaseline', () => {
  it('names the top dish and its share of orders', () => {
    const b = populationBaseline([
      { dishName: 'noodles', orders: 61 },
      { dishName: 'liang pi', orders: 22 },
      { dishName: 'cumin lamb', orders: 17 },
    ]);
    expect(b).toEqual({ topDishName: 'noodles', topDishShare: 0.61 });
  });

  it('says nothing when the venue has too few orders to have a room', () => {
    expect(
      populationBaseline([
        { dishName: 'noodles', orders: 7 },
        { dishName: 'liang pi', orders: 4 },
      ]),
    ).toBeUndefined();
  });

  it('breaks ties deterministically', () => {
    const orders = [
      { dishName: 'zha jiang mian', orders: 25 },
      { dishName: 'ants climbing a tree', orders: 25 },
    ];
    const first = populationBaseline(orders);
    const reversed = populationBaseline([...orders].reverse());
    expect(first).toEqual(reversed);
    expect(first?.topDishName).toBe('ants climbing a tree');
  });

  it('returns undefined rather than dividing by zero on an empty venue', () => {
    expect(populationBaseline([])).toBeUndefined();
  });

  it('rejects negative order counts', () => {
    expect(() => populationBaseline([{ dishName: 'x', orders: -3 }])).toThrow(/non-negative/);
  });

  it('produces a share inside (0, 1]', () => {
    const b = populationBaseline([{ dishName: 'only dish', orders: 40 }]);
    expect(b?.topDishShare).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Handoff to the evidence packet (hard rule 5)
// ---------------------------------------------------------------------------

describe('twinSupportForPacket', () => {
  it('returns nothing at all when the gate refused', () => {
    // Structural absence, not a flag. There is nothing for a renderer to speak
    // from, so it cannot mention twins even by accident.
    const d = decide({ n: 6, positive: 4 }, pop(0.05, 200));
    expect(twinSupportForPacket(d, 'people who, like you, avoid sweetness')).toBeUndefined();
  });

  it('reports supporters, not observations, when the gate passed', () => {
    const d = decide({ n: 12, positive: 9 }, pop(0.3));
    const support = twinSupportForPacket(d, 'people who, like you, avoid sweetness');
    expect(support).toBeDefined();
    expect(support?.n).toBe(9);
    expect(support?.kFloorMet).toBe(true);
    expect(support?.lift).toBeGreaterThan(CONSTANTS.LIFT_DELTA);
    expect(support?.clusterDescriptor).toBe('people who, like you, avoid sweetness');
  });

  it('carries no field describing a person', () => {
    const d = decide({ n: 12, positive: 9 }, pop(0.3));
    const support = twinSupportForPacket(d, 'people who, like you, avoid sweetness');
    // Hard rule 1: no similarity, no reliability, no match score may travel to
    // the renderer, which is the only thing that ever produces user-facing text.
    expect(Object.keys(support ?? {}).sort()).toEqual([
      'clusterDescriptor',
      'kFloorMet',
      'lift',
      'n',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The invariant, over inputs nobody hand-picked
// ---------------------------------------------------------------------------

describe('gate invariants under random input', () => {
  it('never opens the twin channel outside the rules', () => {
    const rand = rng(20260726);
    let passes = 0;

    for (let trial = 0; trial < 4000; trial++) {
      const popN = Math.floor(rand() * 600);
      const popPositive = Math.floor(rand() * (popN + 1));
      const twinN = Math.floor(rand() * 60);
      const twinPositive = Math.floor(rand() * (twinN + 1));

      const d = decide(
        { n: twinN, positive: twinPositive },
        { n: popN, positive: popPositive },
      );

      if (d.channel !== 'twin') continue;
      passes++;

      expect(d.evidence.lift).toBeGreaterThan(CONSTANTS.LIFT_DELTA);
      expect(d.evidence.k).toBeGreaterThanOrEqual(CONSTANTS.K_FLOOR);
      expect(d.evidence.twinObservations).toBeGreaterThanOrEqual(
        LIFT_TUNING.MIN_TWIN_OBSERVATIONS,
      );
      expect(d.evidence.populationObservations).toBeGreaterThanOrEqual(
        LIFT_TUNING.MIN_POPULATION_OBSERVATIONS,
      );
      expect(isBillboard(d.evidence.populationRate)).toBe(false);
    }

    // A gate that refuses everything would satisfy every assertion above, so
    // the sweep is only meaningful if real cases got through.
    expect(passes).toBeGreaterThan(100);
  });

  it('is monotone in supporters, holding the cluster size fixed', () => {
    // One more twin liking it can never make the twin channel less available.
    const population = pop(0.25, 300);
    let seenTwin = false;
    for (let positive = 0; positive <= 20; positive++) {
      const d = decide({ n: 20, positive }, population);
      if (d.channel === 'twin') seenTwin = true;
      // Once the channel opens it must stay open as support increases.
      if (seenTwin) expect(d.channel).toBe('twin');
    }
    expect(seenTwin).toBe(true);
  });
});
