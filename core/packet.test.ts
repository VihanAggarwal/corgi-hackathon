/**
 * Evidence packet tests. Track A.
 *
 * The packet is the privacy boundary, so most of what is tested here is what
 * must NOT come out the other side. Every test below can fail for a real
 * reason: each one corresponds to a leak, a fabricated claim, or a hard rule
 * that would otherwise be enforced only by whoever wrote the prompt.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../contracts/axes';
import { CONSTANTS, type EvidencePacket } from '../contracts/types';
import {
  assertPacketIsClean,
  buildEvidencePacket,
  PacketInputError,
  PacketLeakError,
  __testing,
  type PacketInput,
} from './packet';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function zeros(): number[] {
  return new Array(AXIS_COUNT).fill(0);
}

function vec(entries: Partial<Record<AxisKey, number>>): number[] {
  const v = zeros();
  for (const [key, value] of Object.entries(entries)) {
    v[AXIS_KEYS.indexOf(key as AxisKey)] = value as number;
  }
  return v;
}

function ones(value = 1): number[] {
  return new Array(AXIS_COUNT).fill(value);
}

/**
 * Real ids and real Article 9 values, deliberately. The whole point of the
 * builder is that a caller can hand it the row it actually has.
 */
const USER_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const DEVICE_ID = 'dev_88271qzk4ptw';
const DISH_ID = 'd1b9c33e-77aa-4f10-a6bd-1c2f0e9b4a55';
const TWIN_ID = 'a7c1f9e2-1111-4bcd-8e3a-b0c9d8e7f6a5';
const RELIABILITY = 0.813741;
const COSINE = 0.774219;

function baseInput(overrides: Partial<PacketInput> = {}): PacketInput {
  return {
    user: {
      userId: USER_ID,
      deviceId: DEVICE_ID,
      theta: vec({ acid: 1.8, sweetness_savory: -2.1, umami_depth: 1.2 }),
      nComparisons: 40,
      posteriorVar: 0.2,
    },
    dish: {
      dishId: DISH_ID,
      venueId: 'venue_9931ktz8wq',
      name: 'liang pi',
      venueName: 'Hunan Slurp',
      neighborhood: 'East Village',
      priceCents: 1400,
      phi: vec({ acid: 2.0, umami_depth: 0.9, texture_chew: 1.4 }),
      confidence: ones(0.9),
    },
    sourceChannel: 'content',
    ...overrides,
  };
}

function twinEvidence(n: number, lift: number) {
  return {
    supporters: Array.from({ length: n }, (_, i) => ({
      userId: USER_ID,
      twinUserId: `${TWIN_ID.slice(0, -1)}${i}`,
      cosine: COSINE,
      reliability: RELIABILITY,
      weight: COSINE * RELIABILITY,
    })),
    lift,
    clusterDescriptor: 'people who, like you, will not accept sweetness in savory food',
  };
}

/** A hand-built packet that passes, so poisoning it isolates one variable. */
function cleanPacket(): EvidencePacket {
  return {
    userAxes: [{ axis: 'acid', label: 'acidity', value: 1.8, percentile: 88 }],
    dish: {
      name: 'liang pi',
      venueName: 'Hunan Slurp',
      neighborhood: 'East Village',
      priceCents: 1400,
      phiConfidence: 'high',
    },
    caveats: [{ source: 'venue_data', n: 1, claim: 'closed on Mondays' }],
    sourceChannel: 'content',
    confidence: 'high',
    constraintsAppliedCount: 2,
  };
}

// ---------------------------------------------------------------------------
// The leak surface. This is the reason the file exists.
// ---------------------------------------------------------------------------

describe('privacy boundary', () => {
  it('carries no id, constraint value, or reliability score into the serialized packet', () => {
    const packet = buildEvidencePacket(
      baseInput({
        twin: twinEvidence(7, 0.34),
        sourceChannel: 'twin',
        constraints: [
          { kind: 'religious', value: 'kosher' },
          { kind: 'allergy', value: 'peanut allergy' },
        ],
        caveats: [{ source: 'twin_note', n: 2, claim: 'colder than expected' }],
      }),
    );

    const serialized = JSON.stringify(packet).toLowerCase();
    const mustNotAppear = [
      USER_ID,
      DEVICE_ID,
      DISH_ID,
      TWIN_ID.slice(0, 12),
      'venue_9931',
      'kosher',
      'peanut',
      'allergy',
      'religious',
      String(RELIABILITY),
      String(COSINE),
      '0.8137',
      'reliab',
      'cosine',
      'userid',
      'weight',
    ];

    for (const needle of mustNotAppear) {
      expect(serialized).not.toContain(needle.toLowerCase());
    }
  });

  it('reduces constraints to an integer count and nothing else', () => {
    const packet = buildEvidencePacket(
      baseInput({ constraints: ['kosher', 'peanut allergy', 'no shellfish'] }),
    );

    expect(packet.constraintsAppliedCount).toBe(3);
    expect(Number.isInteger(packet.constraintsAppliedCount)).toBe(true);
    expect(JSON.stringify(packet)).not.toMatch(/kosher|peanut|shellfish/i);
  });

  it('accepts a bare count when the caller has no records', () => {
    const packet = buildEvidencePacket(baseInput({ constraintsAppliedCount: 4 }));
    expect(packet.constraintsAppliedCount).toBe(4);
  });

  it('refuses to guess when the count and the records disagree', () => {
    expect(() =>
      buildEvidencePacket(baseInput({ constraints: ['kosher'], constraintsAppliedCount: 3 })),
    ).toThrow(PacketInputError);
  });

  it('refuses to build when a constraint value reached the dish itself', () => {
    // Upstream set intersection failed: this dish should never have been a
    // candidate for a user with a peanut allergy. Throwing here is the last
    // line, and it is preferable to texting someone a dish that could hurt them.
    expect(() =>
      buildEvidencePacket(
        baseInput({
          constraints: ['peanut allergy'],
          dish: { ...baseInput().dish, name: 'cold peanut noodles' },
        }),
      ),
    ).toThrow(PacketLeakError);
  });

  it('does not flag a dish over a generic token inside a constraint phrase', () => {
    // "dairy free" must not blacklist the word "free". A builder that throws on
    // ordinary menu language is a builder callers will route around.
    const packet = buildEvidencePacket(
      baseInput({
        constraints: ['dairy free'],
        dish: { ...baseInput().dish, name: 'free range chicken rice' },
      }),
    );
    expect(packet.dish.name).toBe('free range chicken rice');
  });
});

// ---------------------------------------------------------------------------
// Leaks found by attacking the builder. Each one shipped once.
// ---------------------------------------------------------------------------

describe('privacy boundary, adversarial', () => {
  it('builds the denylist from a constraint row whose fields are not the ones we expected', () => {
    // The old reader took kind, value, label, note and nothing else. A row from
    // any other table produced an EMPTY denylist while the count still came out
    // right, so the leak was invisible from the outside.
    expect(() =>
      buildEvidencePacket(
        baseInput({
          constraints: [{ constraint_kind: 'allergy', constraint_value: 'sesame' } as never],
          caveats: [{ source: 'venue_data', n: 1, claim: 'everything here is finished with sesame' }],
        }),
      ),
    ).toThrow(PacketLeakError);
  });

  it('finds a constraint value nested inside a row', () => {
    expect(() =>
      buildEvidencePacket(
        baseInput({
          constraints: [{ detail: { text: 'shellfish' }, source: 'onboarding' } as never],
          dish: { ...baseInput().dish, name: 'shellfish congee' },
        }),
      ),
    ).toThrow(PacketLeakError);
  });

  it('reads a constraint recorded as a boolean flag on its own key', () => {
    expect(() =>
      buildEvidencePacket(
        baseInput({
          constraints: [{ sesame: true } as never],
          dish: { ...baseInput().dish, venueName: 'Sesame House' },
        }),
      ),
    ).toThrow(PacketLeakError);
  });

  it('catches a short allergen name in a dish', () => {
    // "soy" and "nut" are three characters, which used to be enough to escape
    // tokenization entirely.
    expect(() =>
      buildEvidencePacket(
        baseInput({
          constraints: ['no soy'],
          dish: { ...baseInput().dish, name: 'soy braised pork belly' },
        }),
      ),
    ).toThrow(PacketLeakError);

    expect(() =>
      buildEvidencePacket(
        baseInput({
          constraints: ['nut allergy'],
          dish: { ...baseInput().dish, name: 'nut brittle sundae' },
        }),
      ),
    ).toThrow(PacketLeakError);
  });

  it('refuses constraints handed over as something other than an array', () => {
    // `constraints: 'kosher'` iterates as six characters: count 6, denylist
    // empty. Both wrong, and neither one visible in the output.
    expect(() => buildEvidencePacket(baseInput({ constraints: 'kosher' as never }))).toThrow(
      PacketInputError,
    );
  });

  it('does not speak Article 9 vocabulary even when it was never given a constraint', () => {
    expect(() =>
      buildEvidencePacket(
        baseInput({
          constraintsAppliedCount: 2,
          twin: {
            n: 6,
            lift: 0.4,
            clusterDescriptor: 'people who, like you, keep halal',
          },
          sourceChannel: 'twin',
        }),
      ),
    ).toThrow(/special category vocabulary/);
  });

  it('still builds an ordinary packet after all of that', () => {
    const packet = buildEvidencePacket(
      baseInput({
        constraints: [{ kind: 'religious', value: 'kosher' }, 'peanut allergy'],
        twin: twinEvidence(6, 0.34),
        sourceChannel: 'twin',
        caveats: [{ source: 'twin_note', n: 2, claim: 'colder than expected' }],
        populationBaseline: { topDishName: 'cumin lamb noodles', topDishShare: 0.4 },
      }),
    );
    expect(packet.constraintsAppliedCount).toBe(2);
    expect(packet.dish.name).toBe('liang pi');
    expect(packet.caveats).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hard rule 5: the twin gate
// ---------------------------------------------------------------------------

describe('twin gate', () => {
  it('omits twinSupport as a KEY below the k floor', () => {
    const packet = buildEvidencePacket(
      baseInput({ twin: twinEvidence(CONSTANTS.K_FLOOR - 1, 0.4), sourceChannel: 'twin' }),
    );

    expect('twinSupport' in packet).toBe(false);
    expect(packet.twinSupport).toBeUndefined();
    expect(JSON.stringify(packet)).not.toContain('twinSupport');
  });

  it('omits twinSupport when lift does not exceed the delta', () => {
    const packet = buildEvidencePacket(
      baseInput({ twin: twinEvidence(9, CONSTANTS.LIFT_DELTA), sourceChannel: 'twin' }),
    );
    expect('twinSupport' in packet).toBe(false);
  });

  it('includes twinSupport when both gates pass', () => {
    const packet = buildEvidencePacket(
      baseInput({ twin: twinEvidence(6, 0.34), sourceChannel: 'twin' }),
    );

    expect(packet.twinSupport).toEqual({
      n: 6,
      lift: 0.34,
      kFloorMet: true,
      clusterDescriptor: 'people who, like you, will not accept sweetness in savory food',
    });
    expect(packet.sourceChannel).toBe('twin');
  });

  it('downgrades sourceChannel to content when the twin channel did not fire', () => {
    // sourceChannel is itself groundable. Left as "twin" it authorizes a
    // sentence about other people with no evidence to cite.
    const packet = buildEvidencePacket(baseInput({ twin: twinEvidence(3, 0.9), sourceChannel: 'twin' }));
    expect(packet.sourceChannel).toBe('content');
  });

  it('drops twin_note caveats when the twin channel did not fire', () => {
    const caveats: PacketInput['caveats'] = [
      { source: 'twin_note', n: 2, claim: 'colder than expected' },
      { source: 'venue_data', n: 1, claim: 'cash only' },
    ];

    const silent = buildEvidencePacket(baseInput({ twin: twinEvidence(2, 0.9), caveats }));
    expect(silent.caveats.map((c) => c.source)).toEqual(['venue_data']);

    const fired = buildEvidencePacket(
      baseInput({ twin: twinEvidence(6, 0.34), sourceChannel: 'twin', caveats }),
    );
    expect(fired.caveats.map((c) => c.source)).toEqual(['twin_note', 'venue_data']);
  });

  it('refuses a twin block it cannot describe in axis language', () => {
    const twin = { ...twinEvidence(8, 0.5), clusterDescriptor: '   ' };
    const packet = buildEvidencePacket(baseInput({ twin, sourceChannel: 'twin' }));
    expect('twinSupport' in packet).toBe(false);
  });

  it('drops a caveat whose source is a near miss for twin_note', () => {
    // The drop was an equality test against 'twin_note'. A row spelling it
    // "twin notes" was not equal, so it survived below the k floor and carried
    // "four of them said" into the packet the renderer is handed.
    const packet = buildEvidencePacket(
      baseInput({
        twin: twinEvidence(2, 0.9),
        caveats: [
          { source: 'twin notes' as never, n: 4, claim: 'four of them said it runs cold' },
          { source: 'venue_data', n: 1, claim: 'cash only' },
        ],
      }),
    );

    expect(packet.caveats).toEqual([{ source: 'venue_data', n: 1, claim: 'cash only' }]);
    expect(JSON.stringify(packet)).not.toContain('four of them');
  });

  it('refuses a sourceChannel outside the contract even when it is not the word twin', () => {
    expect(() =>
      buildEvidencePacket(baseInput({ sourceChannel: 'twin_cluster_of_similar_diners' as never })),
    ).toThrow(PacketLeakError);
  });

  it('refuses free text in the closed enums', () => {
    expect(() =>
      buildEvidencePacket(
        baseInput({
          expansion: {
            outsideRegion: true,
            axis: 'funk_ferment',
            distance: 'far, like the six people near you' as never,
          },
        }),
      ),
    ).toThrow(PacketLeakError);

    const poisoned = { ...cleanPacket(), confidence: 'very high' as never };
    expect(() => assertPacketIsClean(poisoned)).toThrow(PacketLeakError);
  });

  it('rounds lift before gating so the packet does not argue with itself', () => {
    // 0.1502 rounds to 0.15, which does not exceed the delta.
    expect(__testing.gateTwinSupport({ n: 9, lift: 0.1502, clusterDescriptor: 'x' })).toBeNull();
    expect(__testing.gateTwinSupport({ n: 9, lift: 0.1506, clusterDescriptor: 'x' })?.lift).toBe(0.151);
  });
});

// ---------------------------------------------------------------------------
// Driving axes
// ---------------------------------------------------------------------------

describe('driving axes', () => {
  it('never exceeds three even when every axis aligns', () => {
    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: ones(1) },
        dish: { ...baseInput().dish, phi: ones(1) },
      }),
    );
    expect(packet.userAxes.length).toBe(3);
  });

  it('picks by contribution to the score, in order', () => {
    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ acid: 2, umami_depth: 1.5, texture_chew: 1, salt: 0.2 }) },
        dish: { ...baseInput().dish, phi: ones(1), confidence: ones(0.9) },
      }),
    );

    expect(packet.userAxes.map((a) => a.axis)).toEqual(['acid', 'umami_depth', 'texture_chew']);
  });

  it('excludes an axis the dish lost on, however large the term', () => {
    // theta -3 against phi +3 is the biggest magnitude in the vector and the
    // single worst reason to recommend this dish.
    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ sweetness_savory: -3, acid: 1 }) },
        dish: { ...baseInput().dish, phi: vec({ sweetness_savory: 3, acid: 1 }) },
      }),
    );

    expect(packet.userAxes.map((a) => a.axis)).toEqual(['acid']);
  });

  it('never speaks about an axis masked by low extraction confidence', () => {
    const confidence = ones(0.9);
    confidence[AXIS_KEYS.indexOf('acid')] = CONSTANTS.CONF_THRESHOLD - 0.01;

    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ acid: 3, umami_depth: 1 }) },
        dish: { ...baseInput().dish, phi: vec({ acid: 3, umami_depth: 1 }), confidence },
      }),
    );

    expect(packet.userAxes.map((a) => a.axis)).toEqual(['umami_depth']);
  });

  it('honours an extractor mask even when the confidence vector disagrees', () => {
    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ acid: 3, umami_depth: 1 }) },
        dish: {
          ...baseInput().dish,
          phi: vec({ acid: 3, umami_depth: 1 }),
          confidence: ones(0.95),
          maskedAxes: ['acid'],
        },
      }),
    );

    expect(packet.userAxes.map((a) => a.axis)).toEqual(['umami_depth']);
  });

  it('reports no driving axes for a user we know nothing about', () => {
    // A zero theta with a nonzero dish must not produce three axes at
    // contribution zero. "These axes drove it" would be a fabricated claim.
    const packet = buildEvidencePacket(
      baseInput({ user: { theta: zeros() }, dish: { ...baseInput().dish, phi: ones(2) } }),
    );

    expect(packet.userAxes).toEqual([]);
  });

  it('derives percentiles from the z-scored axis and accepts measured ones', () => {
    const derived = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ acid: 1.8 }) },
        dish: { ...baseInput().dish, phi: vec({ acid: 1 }) },
      }),
    );
    expect(derived.userAxes[0].percentile).toBe(96);
    expect(derived.userAxes[0].value).toBe(1.8);

    const axisPercentiles = new Array(AXIS_COUNT).fill(50);
    axisPercentiles[AXIS_KEYS.indexOf('acid')] = 91;
    const measured = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ acid: 1.8 }), axisPercentiles },
        dish: { ...baseInput().dish, phi: vec({ acid: 1 }) },
      }),
    );
    expect(measured.userAxes[0].percentile).toBe(91);
  });

  it('rounds the axis value so a full precision fit is not a fingerprint', () => {
    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ acid: 1.8371829471 }) },
        dish: { ...baseInput().dish, phi: vec({ acid: 1 }) },
      }),
    );
    expect(packet.userAxes[0].value).toBe(1.84);
  });

  it('uses the contract label, never an invented one', () => {
    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ sweetness_savory: -2 }) },
        dish: { ...baseInput().dish, phi: vec({ sweetness_savory: -2 }) },
      }),
    );
    expect(packet.userAxes[0]).toMatchObject({
      axis: 'sweetness_savory',
      label: 'sweetness in savory food',
    });
  });
});

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

describe('expansion', () => {
  it('forces the frontier axis into the driving axes without exceeding three', () => {
    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ acid: 2, umami_depth: 1.5, texture_chew: 1, funk_ferment: -0.2 }) },
        dish: { ...baseInput().dish, phi: ones(1) },
        expansion: { outsideRegion: true, axis: 'funk_ferment', distance: 'adjacent' },
      }),
    );

    const axes = packet.userAxes.map((a) => a.axis);
    expect(axes).toContain('funk_ferment');
    expect(axes).not.toContain('texture_chew');
    expect(packet.userAxes.length).toBe(3);
    expect(packet.expansion).toEqual({
      outsideRegion: true,
      axis: 'funk_ferment',
      distance: 'adjacent',
    });
  });

  it('drops the expansion block when its axis was masked on this dish', () => {
    // Claiming a dish stretches someone on an axis we could not read is a
    // confident sentence with nothing under it.
    const packet = buildEvidencePacket(
      baseInput({
        expansion: { outsideRegion: true, axis: 'funk_ferment', distance: 'far' },
        dish: { ...baseInput().dish, maskedAxes: ['funk_ferment'] },
      }),
    );

    expect('expansion' in packet).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Caveats, dish fields, confidence
// ---------------------------------------------------------------------------

describe('packet fields', () => {
  it('drops malformed caveats rather than rendering them', () => {
    const packet = buildEvidencePacket(
      baseInput({
        caveats: [
          { source: 'venue_data', n: 2.6, claim: '  cash only  ' },
          { source: 'extraction', n: 3, claim: '   ' },
          { source: 'venue_data', n: 0, claim: 'no data' },
        ],
      }),
    );

    expect(packet.caveats).toEqual([{ source: 'venue_data', n: 3, claim: 'cash only' }]);
  });

  it('keeps priceCents an integer or null', () => {
    expect(buildEvidencePacket(baseInput({ dish: { ...baseInput().dish, priceCents: 1399.6 } })).dish.priceCents).toBe(1400);
    expect(buildEvidencePacket(baseInput({ dish: { ...baseInput().dish, priceCents: null } })).dish.priceCents).toBeNull();
  });

  it('clamps the population baseline share and drops an unusable one', () => {
    const clamped = buildEvidencePacket(
      baseInput({ populationBaseline: { topDishName: 'noodles', topDishShare: 1.4 } }),
    );
    expect(clamped.populationBaseline).toEqual({ topDishName: 'noodles', topDishShare: 1 });

    const dropped = buildEvidencePacket(
      baseInput({ populationBaseline: { topDishName: '  ', topDishShare: 0.6 } }),
    );
    expect('populationBaseline' in dropped).toBe(false);
  });

  it('never claims high confidence on a user we barely know', () => {
    const packet = buildEvidencePacket(
      baseInput({ user: { ...baseInput().user, nComparisons: 4, posteriorVar: 0.9 } }),
    );
    expect(packet.confidence).toBe('low');
  });

  it('caps confidence at medium for a vision read', () => {
    const packet = buildEvidencePacket(baseInput({ sourceChannel: 'agent_vision' }));
    expect(packet.confidence).toBe('medium');
  });

  it('lets an override lower confidence but never raise it', () => {
    const lowered = buildEvidencePacket(baseInput({ confidence: 'low' }));
    expect(lowered.confidence).toBe('low');

    const raised = buildEvidencePacket(
      baseInput({
        confidence: 'high',
        user: { ...baseInput().user, nComparisons: 4, posteriorVar: 0.9 },
      }),
    );
    expect(raised.confidence).toBe('low');
  });

  it('rates phi confidence on the axes it is about to speak about', () => {
    const confidence = ones(0.99);
    confidence[AXIS_KEYS.indexOf('acid')] = 0.61;
    const packet = buildEvidencePacket(
      baseInput({
        user: { theta: vec({ acid: 3 }), nComparisons: 40, posteriorVar: 0.2 },
        dish: { ...baseInput().dish, phi: vec({ acid: 3 }), confidence },
      }),
    );

    expect(packet.userAxes.map((a) => a.axis)).toEqual(['acid']);
    expect(packet.dish.phiConfidence).toBe('medium');
  });

  it('refuses to ship a packet built from a broken fit', () => {
    // A NaN in theta survives every comparison in the ranking code and would
    // serialize as null, which the renderer would read as "no value".
    const theta = zeros();
    theta[AXIS_KEYS.indexOf('acid')] = Number.NaN;
    expect(() =>
      buildEvidencePacket(baseInput({ user: { theta }, dish: { ...baseInput().dish, phi: ones(1) } })),
    ).toThrow(PacketLeakError);
  });

  it('rejects a vector that is not 24 long', () => {
    expect(() => buildEvidencePacket(baseInput({ user: { theta: [1, 2, 3] } }))).toThrow(
      PacketInputError,
    );
    expect(() =>
      buildEvidencePacket(baseInput({ dish: { ...baseInput().dish, phi: [1, 2, 3] } })),
    ).toThrow(PacketInputError);
  });
});

// ---------------------------------------------------------------------------
// The assertion itself. If this is asleep, everything above is decoration.
// ---------------------------------------------------------------------------

describe('assertPacketIsClean', () => {
  it('passes a clean packet', () => {
    expect(() => assertPacketIsClean(cleanPacket(), ['kosher'])).not.toThrow();
  });

  it('catches an identifier key added at the root', () => {
    const poisoned = { ...cleanPacket(), userId: 'anything' };
    expect(() => assertPacketIsClean(poisoned)).toThrow(PacketLeakError);
  });

  it('catches an identifier key nested deep inside a block', () => {
    const poisoned = {
      ...cleanPacket(),
      twinSupport: {
        n: 6,
        lift: 0.3,
        kFloorMet: true,
        clusterDescriptor: 'people who avoid sweetness in savory food',
        supporterIds: ['a', 'b'],
      },
    };
    expect(() => assertPacketIsClean(poisoned)).toThrow(/supporterIds|contract/);
  });

  it('catches a reliability score smuggled into a block', () => {
    const poisoned = {
      ...cleanPacket(),
      twinSupport: {
        n: 6,
        lift: 0.3,
        kFloorMet: true,
        clusterDescriptor: 'people who avoid sweetness in savory food',
        reliability: 0.81,
      },
    };
    expect(() => assertPacketIsClean(poisoned)).toThrow(PacketLeakError);
  });

  it('catches a uuid hidden inside prose', () => {
    const poisoned = cleanPacket();
    poisoned.twinSupport = {
      n: 6,
      lift: 0.3,
      kFloorMet: true,
      clusterDescriptor: `people like ${USER_ID} who avoid sweetness in savory food`,
    };
    expect(() => assertPacketIsClean(poisoned)).toThrow(/uuid/);
  });

  it('catches a prefixed device id inside a dish field', () => {
    const poisoned = cleanPacket();
    poisoned.dish.venueName = `Hunan Slurp ${DEVICE_ID}`;
    expect(() => assertPacketIsClean(poisoned)).toThrow(/identifier-shaped/);
  });

  it('catches a constraint value inside a caveat claim', () => {
    // A value the Article 9 vocabulary list cannot know about, so this test
    // exercises the caller-supplied denylist and nothing else.
    const poisoned = cleanPacket();
    poisoned.caveats = [{ source: 'venue_data', n: 1, claim: 'the sesame paste is not optional' }];
    expect(() => assertPacketIsClean(poisoned, ['sesame'])).toThrow(/forbidden input literal/);
    // Without the denylist the same packet is unremarkable, which is exactly
    // why the builder passes its own input in.
    expect(() => assertPacketIsClean(poisoned)).not.toThrow();
  });

  it('catches special category vocabulary with no denylist at all', () => {
    // The denylist can only catch a value somebody handed us. A caller holding
    // nothing but a count is an explicitly supported case, and it must not be
    // the case where "keep kosher" reaches a prompt unchallenged.
    const poisoned = cleanPacket();
    poisoned.caveats = [{ source: 'venue_data', n: 1, claim: 'the kosher menu is separate' }];
    expect(() => assertPacketIsClean(poisoned)).toThrow(/special category vocabulary/);

    const descriptor = cleanPacket();
    descriptor.twinSupport = {
      n: 6,
      lift: 0.4,
      kFloorMet: true,
      clusterDescriptor: 'people who, like you, keep halal',
    };
    expect(() => assertPacketIsClean(descriptor)).toThrow(/special category vocabulary/);
  });

  it('does not flag a word that merely contains a special category term', () => {
    const fine = cleanPacket();
    fine.dish.name = 'coshered beef brisket';
    fine.dish.venueName = 'The Vegantine';
    expect(() => assertPacketIsClean(fine)).not.toThrow();
  });

  it('catches a fourth driving axis', () => {
    const poisoned = cleanPacket();
    poisoned.userAxes = [
      { axis: 'acid', label: 'acidity', value: 1.8, percentile: 88 },
      { axis: 'salt', label: 'salt level', value: 1.1, percentile: 76 },
      { axis: 'umami_depth', label: 'savory depth', value: 1.0, percentile: 70 },
      { axis: 'bitterness', label: 'bitterness', value: 0.9, percentile: 68 },
    ];
    expect(() => assertPacketIsClean(poisoned)).toThrow(/at most 3/);
  });

  it('catches twin support below the floor', () => {
    const poisoned = cleanPacket();
    poisoned.twinSupport = {
      n: CONSTANTS.K_FLOOR - 1,
      lift: 0.4,
      kFloorMet: true,
      clusterDescriptor: 'people who avoid sweetness in savory food',
    };
    expect(() => assertPacketIsClean(poisoned)).toThrow(/k floor/);
  });

  it('catches twin support under the lift delta', () => {
    const poisoned = cleanPacket();
    poisoned.twinSupport = {
      n: 9,
      lift: CONSTANTS.LIFT_DELTA,
      kFloorMet: true,
      clusterDescriptor: 'people who avoid sweetness in savory food',
    };
    expect(() => assertPacketIsClean(poisoned)).toThrow(/lift delta/);
  });

  it('catches a twin sourceChannel with nothing to cite', () => {
    const poisoned = { ...cleanPacket(), sourceChannel: 'twin' as const };
    expect(() => assertPacketIsClean(poisoned)).toThrow(/no twinSupport/);
  });

  it('catches twinSupport present as an undefined-valued key', () => {
    // Assignment instead of spread. `'twinSupport' in packet` is true and the
    // renderer's branch is wrong.
    const poisoned = { ...cleanPacket(), twinSupport: undefined };
    expect(() => assertPacketIsClean(poisoned)).toThrow(PacketLeakError);
  });

  it('catches an invented axis key and a relabelled axis', () => {
    const invented = cleanPacket();
    (invented.userAxes[0] as { axis: string }).axis = 'umami_bomb';
    expect(() => assertPacketIsClean(invented)).toThrow(PacketLeakError);

    const relabelled = cleanPacket();
    relabelled.userAxes[0].label = 'zingy and bright';
    expect(() => assertPacketIsClean(relabelled)).toThrow(/label/);
  });

  it('catches a non-finite number that would serialize as null', () => {
    const poisoned = cleanPacket();
    poisoned.userAxes[0].value = Number.NaN;
    expect(() => assertPacketIsClean(poisoned)).toThrow(/non-finite/);
  });

  it('catches a non-integer constraint count', () => {
    const poisoned = { ...cleanPacket(), constraintsAppliedCount: 2.5 };
    expect(() => assertPacketIsClean(poisoned)).toThrow(/constraintsAppliedCount/);
  });

  it('catches an unexpected nested object', () => {
    const poisoned = { ...cleanPacket(), dish: { ...cleanPacket().dish, name: { text: 'liang pi' } } };
    expect(() => assertPacketIsClean(poisoned)).toThrow(PacketLeakError);
  });

  it('rejects a non-object', () => {
    expect(() => assertPacketIsClean('liang pi')).toThrow(PacketLeakError);
    expect(() => assertPacketIsClean([cleanPacket()])).toThrow(PacketLeakError);
  });
});

// ---------------------------------------------------------------------------
// Conformance to the frozen JSON schema
// ---------------------------------------------------------------------------

describe('evidence-packet.schema.json', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../contracts/evidence-packet.schema.json', import.meta.url), 'utf8'),
  ) as {
    required: string[];
    properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };

  /**
   * Guards against the schema and the builder's allowlist drifting apart. If
   * somebody adds a field to the contract, this fails until the leak scan knows
   * about it, which is the correct order of events.
   */
  it('emits only keys the schema declares, at every level', () => {
    const packet = buildEvidencePacket(
      baseInput({
        twin: twinEvidence(6, 0.34),
        sourceChannel: 'twin',
        populationBaseline: { topDishName: 'noodles', topDishShare: 0.61 },
        caveats: [{ source: 'twin_note', n: 2, claim: 'colder than expected' }],
        expansion: { outsideRegion: true, axis: 'funk_ferment', distance: 'adjacent' },
        constraints: ['kosher'],
      }),
    ) as unknown as Record<string, unknown>;

    for (const key of Object.keys(packet)) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
    for (const key of schema.required) {
      expect(packet).toHaveProperty(key);
    }

    const nested: Array<[string, Record<string, unknown>]> = [
      ['dish', packet.dish as Record<string, unknown>],
      ['twinSupport', packet.twinSupport as Record<string, unknown>],
      ['populationBaseline', packet.populationBaseline as Record<string, unknown>],
      ['expansion', packet.expansion as Record<string, unknown>],
    ];
    for (const [name, block] of nested) {
      const allowed = Object.keys(schema.properties[name].properties ?? {});
      for (const key of Object.keys(block)) expect(allowed).toContain(key);
      for (const key of schema.properties[name].required ?? []) {
        expect(block).toHaveProperty(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Internals worth pinning
// ---------------------------------------------------------------------------

describe('internals', () => {
  it('maps z scores to percentiles monotonically', () => {
    expect(__testing.percentileFromZ(0)).toBe(50);
    expect(__testing.percentileFromZ(-2.1)).toBeLessThan(5);
    expect(__testing.percentileFromZ(1.8)).toBeGreaterThan(90);
    expect(__testing.percentileFromZ(-99)).toBe(0);
    expect(__testing.percentileFromZ(99)).toBe(100);
  });

  it('does not treat generic constraint fragments as denylist tokens', () => {
    const tokens = __testing.buildNeedles({ tokenized: ['dairy free', 'not any of the above'] });
    expect(tokens).toContain('dairy');
    expect(tokens).not.toContain('free');
    for (const stopword of ['not', 'any', 'the']) expect(tokens).not.toContain(stopword);
  });

  it('tokenizes the short allergen words instead of exempting them by length', () => {
    // A four character floor was quietly exempting the three most common short
    // allergen names, so "nut allergy" put "allergy" on the denylist and nothing
    // that would stop a dish called "nut brittle".
    const tokens = __testing.buildNeedles({ tokenized: ['no soy', 'nut allergy', 'egg white'] });
    expect(tokens).toContain('soy');
    expect(tokens).toContain('nut');
    expect(tokens).toContain('egg');
  });

  it('never puts a bare number or an id fragment on the denylist', () => {
    // A constraint row carries a row id and a timestamp. Tokenizing those puts
    // "2026" on the denylist and the next venue with a year in its name throws.
    const tokens = __testing.buildNeedles({
      tokenized: ['2026-07-25T10:00:00Z', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    });
    expect(tokens).not.toContain('2026');
    expect(tokens).not.toContain('3f2504e0');
    expect(tokens).toContain('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('still tokenizes a constraint value that happens to carry a row id', () => {
    const tokens = __testing.buildNeedles({
      tokenized: ['peanut allergy (row 3f2504e0-4f89-11d3-9a0c-0305e82c3301)'],
    });
    expect(tokens).toContain('peanut');
  });

  it('never tokenizes an id, because id prefixes are ordinary words', () => {
    // "venue" out of venue_9931ktz8wq would match the caveat source
    // "venue_data" and block every honest packet.
    const needles = __testing.buildNeedles({ exact: ['venue_9931ktz8wq'] });
    expect(needles).toEqual(['venue_9931ktz8wq']);
  });
});
