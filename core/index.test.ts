/**
 * Track A public surface tests.
 *
 * The point of these is the composed twin-support gate. twins.ts and lift.ts
 * each enforce half of hard rule 5, and a caller reaching for either raw
 * function would satisfy the import while checking half the rule. These assert
 * that the composed gate refuses when EITHER half refuses.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_COUNT } from '../contracts/axes';
import { CONSTANTS } from '../contracts/types';
import { twinSupportForPacket } from './index';
import type { LiftDecision, LiftEvidence, TwinRefusal } from './lift';
import type { TwinComputation } from './twins';

// Fixtures are built against the real types with no casts, so a contract change
// breaks these at compile time rather than letting them quietly test nothing.

function computation(over: Partial<TwinComputation> = {}): TwinComputation {
  return {
    status: { enabled: true, twinCount: 6 },
    links: [],
    clusterDescriptor: 'people who, like you, will not accept sweetness in savory food',
    rejected: [],
    ...over,
  };
}

function evidence(over: Partial<LiftEvidence> = {}): LiftEvidence {
  return {
    lift: 0.32,
    rawTwinRate: 0.75,
    shrunkTwinRate: 0.62,
    populationRate: 0.3,
    k: 6,
    twinObservations: 12,
    populationObservations: 200,
    kFloorMet: true,
    maxPossibleLift: 0.7,
    ...over,
  };
}

function decision(over: Partial<LiftEvidence> = {}): LiftDecision {
  return {
    channel: 'twin',
    reason: 'twin_support_diverges_from_population',
    evidence: evidence(over),
  };
}

function refusal(reason: TwinRefusal, over: Partial<LiftEvidence> = {}): LiftDecision {
  return { channel: 'content', reason, evidence: evidence(over) };
}

describe('twinSupportForPacket (composed gate)', () => {
  it('returns support when both gates pass', () => {
    const support = twinSupportForPacket(computation(), decision());
    expect(support).toBeDefined();
    expect(support?.n).toBe(6);
    expect(support?.kFloorMet).toBe(true);
    expect(support?.lift).toBeGreaterThan(CONSTANTS.LIFT_DELTA);
  });

  // -- the twins half -------------------------------------------------------

  it('refuses when the twin channel is disabled, even with a huge lift', () => {
    const support = twinSupportForPacket(
      computation({ status: { enabled: false, twinCount: 0, reason: 'need_more_duels' } }),
      decision({ lift: 0.9 }),
    );
    expect(support).toBeUndefined();
  });

  it('refuses below the k floor, even with a huge lift', () => {
    const support = twinSupportForPacket(
      computation({ status: { enabled: true, twinCount: CONSTANTS.K_FLOOR - 1 } }),
      decision({ lift: 0.9 }),
    );
    expect(support).toBeUndefined();
  });

  it('refuses when no cluster descriptor exists', () => {
    // Without a descriptor the renderer has no honest way to name the cluster,
    // and naming it dishonestly is the whole failure mode we are avoiding.
    expect(twinSupportForPacket(computation({ clusterDescriptor: null }), decision())).toBeUndefined();
  });

  // -- the lift half --------------------------------------------------------

  it('refuses when lift routed the dish to the content channel', () => {
    // A universally loved dish is a billboard, not word of mouth. It is still
    // recommendable, just never in the voice of twins.
    expect(twinSupportForPacket(computation(), refusal('universally_liked'))).toBeUndefined();
  });

  it('refuses for every distinct lift refusal reason', () => {
    const reasons: TwinRefusal[] = [
      'population_baseline_too_small',
      'universally_liked',
      'not_enough_twin_observations',
      'k_floor_not_met',
      'no_divergence_from_population',
    ];
    for (const reason of reasons) {
      expect(twinSupportForPacket(computation(), refusal(reason))).toBeUndefined();
    }
  });

  it('refuses at exactly LIFT_DELTA, since the gate is strict', () => {
    expect(
      twinSupportForPacket(computation(), decision({ lift: CONSTANTS.LIFT_DELTA })),
    ).toBeUndefined();
  });

  it('refuses when lift says the k floor was not met', () => {
    expect(
      twinSupportForPacket(computation(), decision({ kFloorMet: false })),
    ).toBeUndefined();
  });

  // -- the reason the composed gate exists ----------------------------------

  it('refuses when each half is individually satisfied but the other is not', () => {
    // A caller using only twins.ts would pass this: twins are enabled with a
    // descriptor and a clearing count. A caller using only lift.ts would pass a
    // different one. Only the composition refuses both.
    const twinsOkLiftBad = twinSupportForPacket(
      computation(),
      refusal('no_divergence_from_population'),
    );
    const liftOkTwinsBad = twinSupportForPacket(
      computation({ status: { enabled: false, twinCount: 0, reason: 'population_too_small' } }),
      decision(),
    );
    expect(twinsOkLiftBad).toBeUndefined();
    expect(liftOkTwinsBad).toBeUndefined();
  });

  it('returns undefined rather than a zeroed object, so the field is absent', () => {
    const support = twinSupportForPacket(
      computation({ status: { enabled: false, twinCount: 0, reason: 'need_more_duels' } }),
      decision(),
    );
    // Structural absence is the enforcement mechanism. A zeroed object would
    // survive JSON.stringify and give the renderer something to talk about.
    expect(support).toBeUndefined();
    const packet = { twinSupport: support };
    expect(JSON.stringify(packet)).toBe('{}');
  });

  it('never emits a field describing a person', () => {
    const support = twinSupportForPacket(computation(), decision());
    const keys = Object.keys(support ?? {});
    for (const forbidden of ['reliability', 'cosine', 'weight', 'twinUserIds', 'userId']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('public surface', () => {
  it('does not re-export either raw twinSupportForPacket', async () => {
    // Both exist in their own modules and both are half-gates. If either leaked
    // into the index it would be importable under the same name as the safe one.
    const surface = await import('./index');
    expect(typeof surface.twinSupportForPacket).toBe('function');
    // The composed gate takes two arguments; both raw versions take (x, number)
    // or (x, string). Arity alone is a weak check, so assert behaviour instead:
    // the composed gate must refuse a disabled computation regardless of lift.
    expect(
      surface.twinSupportForPacket(
        computation({ status: { enabled: false, twinCount: 0, reason: 'need_more_duels' } }),
        decision({ lift: 0.99 }),
      ),
    ).toBeUndefined();
  });

  it('exposes the pieces Tracks B and C actually need', async () => {
    const s = await import('./index');
    for (const name of [
      'fitTheta',
      'selectDuels',
      'computeTwins',
      'toClientTwinView',
      'evaluateLift',
      'computeRegion',
      'rankFrontier',
      'buildEvidencePacket',
      'renderRecommendation',
      'validateRendering',
      'generatePalatePortrait',
      'twinSupportForPacket',
    ]) {
      expect(typeof (s as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('keeps AXIS_COUNT aligned with the frozen contract', () => {
    expect(AXIS_COUNT).toBe(24);
  });
});
