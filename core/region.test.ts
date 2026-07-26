/**
 * Palate region and frontier scoring tests. Track A.
 *
 * The sharp one is 'prefers the adjacent unknown over the alien one'. If that
 * test is deleted or weakened, the product becomes a recommender that hands a
 * braise eater a plate of natto and calls it discovery. Everything else here
 * defends a property whose failure would be invisible in a demo: a volume
 * metric that drifts, a frontier that quietly includes axes the user has
 * already eaten across, or a cold-start NaN that only appears for the first
 * user of the day.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_COUNT, AXIS_KEYS, axisIndex, type AxisKey } from '../contracts/axes';
import {
  REGION_CONSTANTS,
  computeRegion,
  expansionForPacket,
  rankFrontier,
  scoreFrontier,
  volumeGrowthFraction,
  __testing,
  type ComputedRegion,
  type RatedDish,
} from './region';

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

/** Seeded PRNG so a failure is reproducible rather than a flaky CI story. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function vec(overrides: Partial<Record<AxisKey, number>> = {}): number[] {
  const v = new Array(AXIS_COUNT).fill(0);
  for (const [k, val] of Object.entries(overrides)) v[axisIndex(k as AxisKey)] = val as number;
  return v;
}

/** A tight cluster of positives around `base`, with small deterministic jitter. */
function cluster(base: number[], n: number, seed: number, amp = 0.15): RatedDish[] {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    dishId: `cluster-${seed}-${i}`,
    rating: 5,
    phi: base.map((b) => b + (rand() - 0.5) * 2 * amp),
  }));
}

function euclid(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < AXIS_COUNT; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
  return Math.sqrt(s);
}

const HEAT = axisIndex('heat_capsaicin');
const SALT = axisIndex('salt');
const UMAMI = axisIndex('umami_depth');
const FUNK = axisIndex('funk_ferment');
const ACID = axisIndex('acid');

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

describe('palate volume', () => {
  it('grows when positives land outside the prior region', () => {
    const base = vec({ heat_capsaicin: 1.2, umami_depth: 1.0 });
    const before = cluster(base, 5, 11);

    // Three dishes that are sharply sour, an axis this user has never touched.
    const stretched = cluster(vec({ heat_capsaicin: 1.2, umami_depth: 1.0, acid: 2.5 }), 3, 12);

    const a = computeRegion(before);
    const b = computeRegion([...before, ...stretched]);

    expect(b.volume).toBeGreaterThan(a.volume + 0.4);
    // The growth must be attributable to the axis that actually moved.
    expect(b.spread[ACID]).toBeGreaterThan(a.spread[ACID] * 5);
    expect(volumeGrowthFraction(a, b)).toBeGreaterThan(0.4);
  });

  it('does not grow when positives land inside the region', () => {
    const base = vec({ heat_capsaicin: 1.2, umami_depth: 1.0 });
    const before = cluster(base, 5, 21);
    const a = computeRegion(before);

    // More of the same. Sitting at the centroid is as inside as it gets.
    const inside: RatedDish[] = Array.from({ length: 3 }, (_, i) => ({
      dishId: `inside-${i}`,
      rating: 5,
      phi: [...a.centroid],
    }));
    const b = computeRegion([...before, ...inside]);

    expect(b.volume).toBeLessThanOrEqual(a.volume);
    expect(b.positiveCount).toBe(8);
    // Sanity: the metric is not simply stuck. The outside case above moves it.
    expect(volumeGrowthFraction(a, b)).toBeLessThanOrEqual(0);
  });

  it('is invariant to the order of the input', () => {
    const logs = cluster(vec({ salt: 1.0, fat_richness: 1.5 }), 7, 31);
    const forward = computeRegion(logs, { now: 'T' });
    const backward = computeRegion([...logs].reverse(), { now: 'T' });

    expect(backward.volume).toBeCloseTo(forward.volume, 12);
    expect(backward.frontierAxes).toEqual(forward.frontierAxes);
    expect(backward.exploredAxes).toEqual(forward.exploredAxes);
  });

  it('counts only positive ratings', () => {
    const base = vec({ heat_capsaicin: 1.2 });
    const positives = cluster(base, 5, 41);

    // Same dishes, but the user rated the sour ones a 3. A shrug is not
    // evidence that the region extends there.
    const shrugged: RatedDish[] = cluster(vec({ heat_capsaicin: 1.2, acid: 2.5 }), 3, 42).map(
      (d) => ({ ...d, rating: 3 }),
    );

    const withShrugs = computeRegion([...positives, ...shrugged]);
    const withoutShrugs = computeRegion(positives);

    expect(withShrugs.positiveCount).toBe(5);
    expect(withShrugs.volume).toBeCloseTo(withoutShrugs.volume, 12);
    expect(withShrugs.frontierAxes).toContain('acid');
  });

  it('ignores masked axes when measuring the region', () => {
    // Axis 'salt' swings hard between dishes, but extraction was not confident
    // about it. If masking leaked, this user would look like a salt explorer on
    // the strength of numbers nobody measured.
    const rand = rng(51);
    const swinging: RatedDish[] = Array.from({ length: 6 }, (_, i) => ({
      dishId: `swing-${i}`,
      rating: 5,
      phi: vec({ heat_capsaicin: 1.2 }).map((b, ax) =>
        ax === SALT ? (i % 2 === 0 ? 3 : -3) : b + (rand() - 0.5) * 0.3,
      ),
    }));

    const unmasked = computeRegion(swinging);
    const masked = computeRegion(swinging.map((d) => ({ ...d, maskedIdx: [SALT] })));

    expect(masked.axisSupport[SALT]).toBe(0);
    expect(masked.spread[SALT]).toBe(0);
    expect(masked.frontierAxes).toContain('salt');
    expect(unmasked.frontierAxes).not.toContain('salt');
    expect(masked.volume).toBeLessThan(unmasked.volume - 1);
  });
});

describe('volumeGrowthFraction', () => {
  it('reads a log-volume delta as a fraction of the space', () => {
    const growth = volumeGrowthFraction({ volume: 2 }, { volume: 2 + Math.log(1.4) });
    expect(growth).toBeCloseTo(0.4, 10);
  });

  it('returns 0 rather than a non-finite number on degenerate input', () => {
    expect(volumeGrowthFraction({ volume: NaN }, { volume: 3 })).toBe(0);
    expect(volumeGrowthFraction({ volume: 0 }, { volume: Infinity })).toBe(0);
    expect(volumeGrowthFraction({ volume: 0 }, { volume: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Frontier and explored axes
// ---------------------------------------------------------------------------

describe('frontierAxes', () => {
  it('lists exactly the axes with no distinctive positive rating', () => {
    const base = vec({ heat_capsaicin: 1.5, umami_depth: 1.2, funk_ferment: -1.4 });
    const region = computeRegion(cluster(base, 6, 61));

    const touched: AxisKey[] = ['heat_capsaicin', 'umami_depth', 'funk_ferment'];
    const expected = AXIS_KEYS.filter((k) => !touched.includes(k));

    expect([...region.frontierAxes].sort()).toEqual([...expected].sort());
    for (const k of touched) expect(region.frontierAxes).not.toContain(k);
  });

  it('treats a negative rating on an axis as touched, not untouched', () => {
    // A user who eats resolutely mild food has an opinion about heat. The axis
    // is not frontier just because the value is below zero.
    const region = computeRegion(cluster(vec({ heat_capsaicin: -2.0 }), 5, 62));
    expect(region.frontierAxes).not.toContain('heat_capsaicin');
  });

  it('puts every axis on the frontier at cold start', () => {
    expect(computeRegion([]).frontierAxes).toHaveLength(AXIS_COUNT);
  });
});

describe('exploredAxes', () => {
  it('names an axis where a positive sits past one sd from the centroid', () => {
    const base = vec({ heat_capsaicin: 1.0 });
    const logs = [
      ...cluster(base, 6, 71),
      // One genuine outlier well beyond the cluster on funk.
      { dishId: 'outlier', rating: 5, phi: vec({ heat_capsaicin: 1.0, funk_ferment: 2.6 }) },
    ];
    const region = computeRegion(logs);

    expect(region.exploredAxes).toContain('funk_ferment');
    // Heat is where they live, not where they explored.
    expect(region.exploredAxes).not.toContain('heat_capsaicin');
  });

  it('never reports exploration on an axis it also calls frontier', () => {
    const region = computeRegion(cluster(vec({ salt: 1.4 }), 9, 72, 0.4));
    const frontier = new Set(region.frontierAxes);
    for (const k of region.exploredAxes) expect(frontier.has(k)).toBe(false);
  });

  it('does not call rounding noise exploration', () => {
    // Nine near-identical dishes. Measured spread is tiny, so without the floor
    // any wobble would read as one sd of exploration on all 24 axes.
    const region = computeRegion(cluster(vec({ salt: 1.0 }), 9, 73, 0.01));
    expect(region.exploredAxes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE test: boundary distance, not centroid distance
// ---------------------------------------------------------------------------

describe('frontier scoring', () => {
  /**
   * A user who lives at moderate heat and deep savory. theta is deliberately
   * zero everywhere except those two axes, so any dish that matches the
   * centroid on them has exactly the same predicted enjoyment no matter what it
   * does elsewhere. That is what lets these tests isolate novelty.
   */
  function braiseEater(): { region: ComputedRegion; theta: number[] } {
    const base = vec({ heat_capsaicin: 1.2, umami_depth: 1.0 });
    return {
      region: computeRegion(cluster(base, 8, 81)),
      theta: vec({ heat_capsaicin: 1.0, umami_depth: 0.8 }),
    };
  }

  it('prefers the adjacent unknown over the alien one at equal predicted enjoyment', () => {
    const { region, theta } = braiseEater();
    const c = region.centroid;

    // One step past the boundary on a single axis: a mildly funky version of
    // food this person already eats.
    const adjacentPhi = [...c];
    adjacentPhi[FUNK] = c[FUNK] + region.halfWidth[FUNK] + REGION_CONSTANTS.ADJACENCY_SCALE * region.halfWidth[FUNK];

    // The natto plate: extreme on ten axes at once.
    const alienPhi = [...c];
    for (let i = 10; i < 20; i++) alienPhi[i] = 3.0;

    const adjacent = scoreFrontier({ dishId: 'adjacent', phi: adjacentPhi }, region, theta);
    const alien = scoreFrontier({ dishId: 'alien', phi: alienPhi }, region, theta);

    // Predicted enjoyment is held equal by construction. If this fails the rest
    // of the test proves nothing.
    expect(adjacent.pPositive).toBeCloseTo(alien.pPositive, 12);

    // A centroid rule would rank these the other way round. That is the whole
    // point of the file, so assert the counterfactual explicitly.
    expect(euclid(alienPhi, c)).toBeGreaterThan(euclid(adjacentPhi, c));

    expect(adjacent.score).toBeGreaterThan(alien.score * 100);
    expect(adjacent.distance).toBe('adjacent');
    expect(adjacent.primaryAxis).toBe('funk_ferment');
    expect(alien.distance).toBe('far');
    expect(rankFrontier([{ dishId: 'alien', phi: alienPhi }, { dishId: 'adjacent', phi: adjacentPhi }], region, theta)[0].dishId).toBe('adjacent');
  });

  it('still prefers the adjacent unknown when the alien dish predicts slightly better', () => {
    const { region, theta } = braiseEater();
    const c = region.centroid;

    const adjacentPhi = [...c];
    adjacentPhi[FUNK] = c[FUNK] + 2 * region.halfWidth[FUNK];

    const alienPhi = [...c];
    // Nudged up on heat, still inside the region there, so it scores higher on
    // predicted enjoyment. It is also extreme on ten axes at once.
    alienPhi[HEAT] = c[HEAT] + 0.9 * region.halfWidth[HEAT];
    for (let i = 10; i < 20; i++) alienPhi[i] = 3.0;

    const adjacent = scoreFrontier({ dishId: 'adjacent', phi: adjacentPhi }, region, theta);
    const alien = scoreFrontier({ dishId: 'alien', phi: alienPhi }, region, theta);

    expect(alien.pPositive).toBeGreaterThan(adjacent.pPositive);
    expect(adjacent.score).toBeGreaterThan(alien.score);
  });

  it('prefers one axis of movement over four small ones at once', () => {
    const { region, theta } = braiseEater();
    const c = region.centroid;

    const oneAxis = [...c];
    oneAxis[FUNK] = c[FUNK] + 2 * region.halfWidth[FUNK];

    const fourAxes = [...c];
    for (const ax of [FUNK, ACID, axisIndex('bitterness'), axisIndex('texture_chew')]) {
      fourAxes[ax] = c[ax] + 2 * region.halfWidth[ax];
    }

    const a = scoreFrontier({ dishId: 'one', phi: oneAxis }, region, theta);
    const b = scoreFrontier({ dishId: 'four', phi: fourAxes }, region, theta);

    expect(a.pPositive).toBeCloseTo(b.pPositive, 12);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.distance).toBe('adjacent');
    // Four new things at once is not a step, and the user could not attribute
    // the result to any one of them.
    expect(b.distance).toBe('far');
  });

  it('scores a dish inside the region at zero expansion value', () => {
    const { region, theta } = braiseEater();
    const inside = [...region.centroid];
    inside[FUNK] = region.centroid[FUNK] + 0.5 * region.halfWidth[FUNK];

    const s = scoreFrontier({ dishId: 'inside', phi: inside }, region, theta);

    expect(s.outsideRegion).toBe(false);
    expect(s.boundaryDistance).toBe(0);
    expect(s.novelty).toBe(0);
    expect(s.score).toBe(0);
    expect(s.distance).toBeNull();
    expect(s.primaryAxis).toBeNull();
    expect(expansionForPacket(s)).toBeUndefined();
  });

  it('treats the boundary itself as the zero point of novelty', () => {
    const { region, theta } = braiseEater();
    const atEdge = [...region.centroid];
    atEdge[FUNK] = region.centroid[FUNK] + region.halfWidth[FUNK];

    const s = scoreFrontier({ dishId: 'edge', phi: atEdge }, region, theta);
    expect(s.outsideRegion).toBe(false);
    expect(s.novelty).toBe(0);
  });

  it('measures the boundary per axis, not as one global radius', () => {
    // Wide on acid, narrow everywhere else. The same absolute step means
    // different things on the two axes, which a global radius cannot express.
    const rand = rng(91);
    const logs: RatedDish[] = Array.from({ length: 8 }, (_, i) => ({
      dishId: `wide-${i}`,
      rating: 5,
      phi: vec().map((_, ax) => (ax === ACID ? (i - 3.5) * 0.8 : (rand() - 0.5) * 0.1)),
    }));
    const region = computeRegion(logs);
    const theta = vec();

    expect(region.halfWidth[ACID]).toBeGreaterThan(1.5);
    expect(region.halfWidth[FUNK]).toBeCloseTo(REGION_CONSTANTS.SPREAD_FLOOR, 10);

    // Identical absolute displacement from the centroid, opposite verdicts.
    const alongWide = vec({ acid: 1.5 });
    const alongNarrow = vec({ funk_ferment: 1.5 });
    const wide = scoreFrontier({ dishId: 'w', phi: alongWide }, region, theta);
    const narrow = scoreFrontier({ dishId: 'n', phi: alongNarrow }, region, theta);

    // Equal to within the jitter in the fixture, which is the point.
    expect(euclid(alongWide, region.centroid)).toBeCloseTo(
      euclid(alongNarrow, region.centroid),
      1,
    );
    expect(wide.outsideRegion).toBe(false);
    expect(narrow.outsideRegion).toBe(true);
    // Any rule based on distance from the centroid would tie these two. Only a
    // boundary rule can say that one is familiar and the other is a step out.
    expect(narrow.score).toBeGreaterThan(wide.score);
  });

  it('ignores masked axes on the candidate', () => {
    const { region, theta } = braiseEater();
    const phi = [...region.centroid];
    phi[FUNK] = 3.0;

    const unmasked = scoreFrontier({ dishId: 'd', phi }, region, theta);
    const masked = scoreFrontier({ dishId: 'd', phi, maskedIdx: [FUNK] }, region, theta);

    expect(unmasked.outsideRegion).toBe(true);
    // An axis we could not extract is not evidence of novelty, so the dish is
    // not a frontier candidate on the strength of a number we do not trust.
    expect(masked.outsideRegion).toBe(false);
    expect(masked.score).toBe(0);
  });

  it('accepts a calibrated pPositive instead of deriving one from theta', () => {
    const { region, theta } = braiseEater();
    const phi = [...region.centroid];
    phi[FUNK] = region.centroid[FUNK] + 2 * region.halfWidth[FUNK];

    const derived = scoreFrontier({ dishId: 'd', phi }, region, theta);
    const supplied = scoreFrontier({ dishId: 'd', phi, pPositive: 0.5 }, region, theta);

    expect(supplied.pPositive).toBe(0.5);
    expect(supplied.novelty).toBeCloseTo(derived.novelty, 12);
    expect(supplied.score).toBeCloseTo(0.5 * derived.novelty, 12);
  });

  it('ranks deterministically when scores tie', () => {
    const { region, theta } = braiseEater();
    const phi = [...region.centroid];
    const ranked = rankFrontier(
      [
        { dishId: 'c', phi },
        { dishId: 'a', phi },
        { dishId: 'b', phi },
      ],
      region,
      theta,
    );
    expect(ranked.map((r) => r.dishId)).toEqual(['a', 'b', 'c']);
  });
});

describe('novelty kernel', () => {
  it('is zero at the boundary and peaks one adjacency unit out', () => {
    expect(__testing.noveltyKernel(0)).toBe(0);
    expect(__testing.noveltyKernel(REGION_CONSTANTS.ADJACENCY_SCALE)).toBeCloseTo(1, 12);
  });

  it('decays past the peak rather than rising forever', () => {
    const near = __testing.noveltyKernel(1);
    const mid = __testing.noveltyKernel(4);
    const wild = __testing.noveltyKernel(20);

    expect(mid).toBeLessThan(near);
    expect(wild).toBeLessThan(mid);
    // A monotone-in-distance novelty term would fail here, and that failure is
    // exactly the natto bug.
    expect(wild).toBeLessThan(1e-5);
    expect(wild).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Cold start and degenerate input
// ---------------------------------------------------------------------------

describe('cold start', () => {
  it('reports no region for zero positives without producing a degenerate volume', () => {
    const region = computeRegion([]);

    expect(region.established).toBe(false);
    expect(region.positiveCount).toBe(0);
    expect(region.volume).toBe(0);
    expect(region.exploredAxes).toEqual([]);
    expect(region.frontierAxes).toHaveLength(AXIS_COUNT);
    expect(region.centroid.every(Number.isFinite)).toBe(true);
    expect(region.spread.every(Number.isFinite)).toBe(true);
    expect(region.halfWidth.every((w) => Number.isFinite(w) && w > 0)).toBe(true);
  });

  it('reports no region for a single positive', () => {
    const region = computeRegion([
      { dishId: 'only', rating: 5, phi: vec({ heat_capsaicin: 2.5, funk_ferment: -1.9 }) },
    ]);

    expect(region.established).toBe(false);
    expect(region.volume).toBe(0);
    expect(Number.isFinite(region.volume)).toBe(true);
    expect(region.spread.every((s) => s === 0)).toBe(true);
    expect(region.centroid.every(Number.isFinite)).toBe(true);
  });

  it('falls back to predicted enjoyment and claims no expansion with no region', () => {
    const region = computeRegion([{ dishId: 'only', rating: 5, phi: vec({ salt: 1 }) }]);
    const theta = vec({ heat_capsaicin: 1.5 });

    const hot = scoreFrontier({ dishId: 'hot', phi: vec({ heat_capsaicin: 2 }) }, region, theta);
    const mild = scoreFrontier({ dishId: 'mild', phi: vec({ heat_capsaicin: -2 }) }, region, theta);

    expect(hot.regionEstablished).toBe(false);
    expect(hot.outsideRegion).toBe(false);
    expect(hot.distance).toBeNull();
    expect(expansionForPacket(hot)).toBeUndefined();

    // Ranking still has to do something sensible, and the only signal available
    // is predicted enjoyment.
    expect(hot.score).toBeGreaterThan(mild.score);
    expect(hot.score).toBeCloseTo(hot.pPositive, 12);
    expect(Number.isFinite(hot.score)).toBe(true);
  });

  it('survives identical dishes, which give a region with no extent', () => {
    const phi = vec({ heat_capsaicin: 1.0, salt: 0.8 });
    const region = computeRegion(
      Array.from({ length: 10 }, (_, i) => ({ dishId: `same-${i}`, rating: 5, phi: [...phi] })),
    );

    expect(region.established).toBe(true);
    // At the floor of the metric. Not exactly zero because the mean of ten
    // identical doubles is not exactly that double, and chasing that with a
    // clamp would put an arbitrary epsilon in the model to please a test.
    expect(region.volume).toBeCloseTo(0, 12);
    expect(region.volume).toBeGreaterThanOrEqual(0);
    expect(region.halfWidth.every((w) => w === REGION_CONSTANTS.SPREAD_FLOOR)).toBe(true);

    // The floored half-width is the only thing standing between this and a
    // divide by zero.
    const s = scoreFrontier({ dishId: 'x', phi: vec({ funk_ferment: 2 }) }, region, vec());
    expect(Number.isFinite(s.score)).toBe(true);
    expect(Number.isFinite(s.boundaryDistance)).toBe(true);
    expect(Number.isNaN(s.novelty)).toBe(false);
  });

  it('drops non-finite axis values rather than propagating them', () => {
    const bad = vec({ heat_capsaicin: 1.0 });
    bad[SALT] = NaN;
    const logs: RatedDish[] = [
      { dishId: 'a', rating: 5, phi: bad },
      { dishId: 'b', rating: 5, phi: vec({ heat_capsaicin: 1.4, salt: 0.9 }) },
      { dishId: 'c', rating: 5, phi: vec({ heat_capsaicin: 0.8, salt: 1.1 }) },
    ];
    const region = computeRegion(logs);

    expect(region.axisSupport[SALT]).toBe(2);
    expect(Number.isFinite(region.volume)).toBe(true);
    expect(region.centroid.every(Number.isFinite)).toBe(true);
    expect(region.spread.every(Number.isFinite)).toBe(true);

    const candidate = vec({ funk_ferment: 1.5 });
    candidate[UMAMI] = Infinity;
    const s = scoreFrontier({ dishId: 'z', phi: candidate }, region, vec());
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.outsideAxes).not.toContain('umami_depth');
  });
});

// ---------------------------------------------------------------------------
// Packet discipline
// ---------------------------------------------------------------------------

describe('expansionForPacket', () => {
  it('emits exactly the three contract fields and no numbers about the person', () => {
    const base = vec({ heat_capsaicin: 1.2, umami_depth: 1.0 });
    const region = computeRegion(cluster(base, 8, 101));
    const phi = [...region.centroid];
    phi[FUNK] = region.centroid[FUNK] + 2 * region.halfWidth[FUNK];

    const s = scoreFrontier({ dishId: 'd', phi }, region, vec({ heat_capsaicin: 1 }));
    const expansion = expansionForPacket(s);

    expect(expansion).toBeDefined();
    expect(Object.keys(expansion!).sort()).toEqual(['axis', 'distance', 'outsideRegion']);
    expect(expansion!.outsideRegion).toBe(true);
    expect(expansion!.axis).toBe('funk_ferment');
    expect(expansion!.distance).toBe('adjacent');
    // Hard rule 1: no score, no distance number, nothing rankable about a human
    // may leave in the packet.
    expect(JSON.stringify(expansion)).not.toContain(String(s.boundaryDistance));
  });
});
