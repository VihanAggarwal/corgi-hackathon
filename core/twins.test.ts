/**
 * Twin computation tests. Track A.
 *
 * Two things are being defended here and they fail in opposite directions.
 * Under-gating ships a fabricated twin ring to a real user. Over-gating turns
 * the twin channel off for a legitimate population and makes the product a
 * worse Google. Every test below is one of those two.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_COUNT } from '../contracts/axes';
import { CONSTANTS, type TwinStatus } from '../contracts/types';
import {
  clusterDescriptor,
  computeTwins,
  cosineSimilarity,
  toClientTwinView,
  twinSupportForPacket,
  type AccountProvenance,
  type ClientTwinView,
  type TwinCandidate,
  type TwinComputationInput,
  __testing,
} from './twins';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const BASE = Date.parse('2026-03-01T12:00:00.000Z');

function iso(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

/** A user with a few strong opinions, the realistic shape of a fitted theta. */
function sparseTheta(): number[] {
  const t = new Array(AXIS_COUNT).fill(0);
  t[0] = 2.0; // chili heat
  t[4] = -2.4; // sweetness in savory food
  t[9] = 1.6; // ferment and funk
  t[21] = -1.2; // ingredient familiarity
  return t;
}

/** Same direction as sparseTheta, jittered, so cosine stays above tau. */
function nearTheta(jitter: number): number[] {
  const t = sparseTheta();
  return t.map((v, i) => v + (i % 3 === 0 ? jitter : -jitter));
}

/** Provenance that is independent of everything else by construction. */
function independentProvenance(i: number): AccountProvenance {
  return {
    inviterId: `organic-root-${i}`,
    fingerprint: `device-${i}`,
    // Days apart, so the burst window cannot fire.
    createdAt: iso(i * 24 * HOUR),
  };
}

function candidate(
  id: string,
  overrides: Partial<TwinCandidate> = {},
  provenance?: Partial<AccountProvenance>,
): TwinCandidate {
  const n = Number(id.replace(/\D/g, '')) || 1;
  return {
    userId: id,
    theta: nearTheta(0.1 * (n % 4)),
    nComparisons: 40,
    reliability: 0.8,
    provenance: { ...independentProvenance(n), ...provenance },
    ...overrides,
  };
}

/** Five candidates who differ in nothing except the provenance under test. */
function ring(provenanceFor: (i: number) => Partial<AccountProvenance>): TwinCandidate[] {
  return [1, 2, 3, 4, 5].map((i) => candidate(`fake-${i}`, {}, provenanceFor(i)));
}

function independentFive(): TwinCandidate[] {
  return [1, 2, 3, 4, 5].map((i) => candidate(`real-${i}`));
}

function input(over: Partial<TwinComputationInput> = {}): TwinComputationInput {
  return {
    self: { userId: 'me', theta: sparseTheta(), nComparisons: 60 },
    candidates: independentFive(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('is 1 for the same direction regardless of magnitude', () => {
    const a = sparseTheta();
    const b = a.map((v) => v * 0.2);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  it('is 0 against a vector with no magnitude', () => {
    // A brand new user is all zeros after shrinkage. They must not read as a
    // perfect match for everyone, which is what an unguarded division gives.
    expect(cosineSimilarity(sparseTheta(), new Array(AXIS_COUNT).fill(0))).toBe(0);
  });

  it('is negative for an opposed palate', () => {
    const a = sparseTheta();
    expect(cosineSimilarity(a, a.map((v) => -v))).toBeCloseTo(-1, 10);
  });
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe('computeTwins gating', () => {
  it('is off with a reason when the requester has too few duels', () => {
    const result = computeTwins(
      input({ self: { userId: 'me', theta: sparseTheta(), nComparisons: CONSTANTS.MIN_DUELS_FOR_TWINS - 1 } }),
    );

    expect(result.status.enabled).toBe(false);
    expect(result.status.reason).toBe<TwinStatus['reason']>('need_more_duels');
    expect(result.status.twinCount).toBe(0);
    // A caller ignoring status must still have nothing to render.
    expect(result.links).toHaveLength(0);
    expect(result.clusterDescriptor).toBeNull();
  });

  it('turns on at exactly the threshold, not one duel later', () => {
    const result = computeTwins(
      input({ self: { userId: 'me', theta: sparseTheta(), nComparisons: CONSTANTS.MIN_DUELS_FOR_TWINS } }),
    );
    expect(result.status.enabled).toBe(true);
  });

  it('does not count a twin who is themselves under-calibrated', () => {
    // Both users need the duels. A twin fitted on 20 duels is endorsing dishes
    // on the strength of a vector that is mostly population prior.
    const under = independentFive().map((c) => ({ ...c, nComparisons: 20 }));
    const result = computeTwins(input({ candidates: under }));

    expect(result.status.enabled).toBe(false);
    expect(result.status.reason).toBe<TwinStatus['reason']>('population_too_small');
  });

  it('excludes candidates below the cosine floor', () => {
    const opposed = independentFive().map((c, i) => ({
      ...c,
      theta: i < 2 ? c.theta.map((v) => -v) : c.theta,
    }));
    const result = computeTwins(input({ candidates: opposed }));

    expect(result.status.enabled).toBe(false);
    expect(result.status.twinCount).toBe(3);
    expect(result.status.reason).toBe<TwinStatus['reason']>('population_too_small');
  });

  it('never returns itself as its own twin', () => {
    const withSelf = [
      ...independentFive(),
      candidate('me', { theta: sparseTheta(), userId: 'me' }),
    ];
    const result = computeTwins(input({ candidates: withSelf }));
    expect(result.links.map((l) => l.twinUserId)).not.toContain('me');
  });

  it('reports population_too_small when the pool is simply thin', () => {
    const result = computeTwins(input({ candidates: independentFive().slice(0, 4) }));
    expect(result.status.enabled).toBe(false);
    expect(result.status.twinCount).toBe(4);
    expect(result.status.reason).toBe<TwinStatus['reason']>('population_too_small');
  });
});

// ---------------------------------------------------------------------------
// Weighting
// ---------------------------------------------------------------------------

describe('weighting', () => {
  it('accepts five independent twins and weights them by cosine times reliability', () => {
    const result = computeTwins(input());

    expect(result.status.enabled).toBe(true);
    expect(result.status.twinCount).toBe(CONSTANTS.K_FLOOR);
    expect(result.rejected).toHaveLength(0);
    for (const link of result.links) {
      expect(link.cosine).toBeGreaterThanOrEqual(CONSTANTS.TWIN_COSINE_TAU);
      expect(link.weight).toBeCloseTo(link.cosine * link.reliability, 12);
      expect(link.userId).toBe('me');
    }
    // Ranked strongest first, deterministically.
    const weights = result.links.map((l) => l.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  it('drops a similar but perfectly unreliable twin rather than counting them', () => {
    // "A user who is similar but noisy contributes nothing." If a zero-weight
    // twin still counted toward k, the floor would be clearable with noise.
    const noisy = independentFive().map((c, i) => (i === 0 ? { ...c, reliability: 0 } : c));
    const result = computeTwins(input({ candidates: noisy }));

    expect(result.status.twinCount).toBe(4);
    expect(result.status.enabled).toBe(false);
    expect(result.links.map((l) => l.twinUserId)).not.toContain('real-1');
  });

  it('ranks a slightly less similar reliable twin above a very similar noisy one', () => {
    const twins = [
      candidate('noisy8', { theta: sparseTheta(), reliability: 0.3 }),
      candidate('steady9', { theta: nearTheta(0.3), reliability: 0.95 }),
      ...independentFive().slice(0, 3),
    ];
    const result = computeTwins(input({ candidates: twins }));
    const order = result.links.map((l) => l.twinUserId);

    expect(order).toContain('steady9');
    expect(order).toContain('noisy8');
    expect(order.indexOf('steady9')).toBeLessThan(order.indexOf('noisy8'));
  });

  it('is unaffected by who invited whom, only by whether they are entangled', () => {
    // The anti social graph property. Same five people, two different invite
    // worlds, identical similarity and identical weights.
    const anonymous = independentFive().map((c) => ({
      ...c,
      provenance: { ...c.provenance, inviterId: null },
    }));
    const invited = independentFive().map((c, i) => ({
      ...c,
      provenance: { ...c.provenance, inviterId: `friend-of-me-${i}` },
    }));

    const a = computeTwins(input({ candidates: anonymous }));
    const b = computeTwins(input({ candidates: invited }));

    expect(a.status).toEqual(b.status);
    expect(a.links).toEqual(b.links);
  });
});

// ---------------------------------------------------------------------------
// Independence. The anti-astroturf core.
// ---------------------------------------------------------------------------

describe('independence', () => {
  it('collapses five accounts made on one device', () => {
    const result = computeTwins(
      input({ candidates: ring(() => ({ fingerprint: 'one-back-office-laptop' })) }),
    );

    expect(result.status.enabled).toBe(false);
    expect(result.status.reason).toBe<TwinStatus['reason']>('population_too_small');
    // Exactly one of the ring survives, the rest are named as one actor.
    expect(result.status.twinCount).toBe(1);
    expect(result.rejected).toHaveLength(4);
    expect(result.rejected.every((r) => r.violation === 'shared_fingerprint')).toBe(true);
  });

  it('collapses five accounts sharing one inviter', () => {
    const result = computeTwins(
      input({
        candidates: ring((i) => ({
          inviterId: 'the-restaurant',
          fingerprint: `spoofed-device-${i}`,
          createdAt: iso(i * 24 * HOUR),
        })),
      }),
    );

    expect(result.status.enabled).toBe(false);
    expect(result.status.twinCount).toBe(1);
    expect(result.rejected.every((r) => r.violation === 'shared_invite_chain')).toBe(true);
  });

  it('follows an invite chain to a common root two hops up', () => {
    // Each fake was invited by a different intermediary, and every intermediary
    // was invited by the same account. A one-hop check would pass this.
    const chain = new Map<string, string | null>([
      ['middle-a', 'the-root'],
      ['middle-b', 'the-root'],
      ['middle-c', 'the-root'],
      ['middle-d', 'the-root'],
      ['middle-e', 'the-root'],
      ['the-root', null],
    ]);
    const fakes = ring((i) => ({
      inviterId: ['middle-a', 'middle-b', 'middle-c', 'middle-d', 'middle-e'][i - 1],
      fingerprint: `spoofed-${i}`,
      createdAt: iso(i * 24 * HOUR),
    }));

    const result = computeTwins(input({ candidates: fakes, inviterChain: chain }));

    expect(result.status.enabled).toBe(false);
    expect(result.status.twinCount).toBe(1);
    expect(result.rejected.every((r) => r.violation === 'shared_invite_chain')).toBe(true);
  });

  it('collapses a burst of accounts created minutes apart', () => {
    const result = computeTwins(
      input({
        candidates: ring((i) => ({
          inviterId: `distinct-root-${i}`,
          fingerprint: `distinct-device-${i}`,
          // Two minutes apart: different devices, different invites, one script.
          createdAt: iso(i * 2 * 60 * 1000),
        })),
      }),
    );

    expect(result.status.enabled).toBe(false);
    expect(result.status.twinCount).toBe(1);
    expect(result.rejected.every((r) => r.violation === 'creation_burst')).toBe(true);
  });

  it('does not treat accounts created outside the window as a burst', () => {
    const spaced = [1, 2, 3, 4, 5].map((i) =>
      candidate(`real-${i}`, {}, { createdAt: iso(i * (__testing.ACCOUNT_BURST_WINDOW_MS + 60_000)) }),
    );
    const result = computeTwins(input({ candidates: spaced }));
    expect(result.status.enabled).toBe(true);
    expect(result.status.twinCount).toBe(5);
  });

  it('keeps the strongest member of an entangled group, not an arbitrary one', () => {
    const shared = ring(() => ({ fingerprint: 'one-laptop' })).map((c, i) => ({
      ...c,
      reliability: i === 3 ? 0.99 : 0.4,
      theta: sparseTheta(),
    }));
    const result = computeTwins(input({ candidates: [...shared, ...independentFive()] }));

    const survivors = result.links.map((l) => l.twinUserId).filter((id) => id.startsWith('fake-'));
    expect(survivors).toEqual(['fake-4']);
  });

  it('rejects an account whose creation time cannot be read', () => {
    // Fails closed. An account we cannot date cannot be shown to be independent,
    // and fabricated accounts are exactly the ones with missing metadata.
    const undateable = independentFive().map((c, i) =>
      i === 0 ? { ...c, provenance: { ...c.provenance, createdAt: 'not-a-date' } } : c,
    );
    const result = computeTwins(input({ candidates: undateable }));

    expect(result.status.twinCount).toBe(4);
    expect(result.rejected).toEqual([{ userId: 'real-1', violation: 'unverifiable_provenance' }]);
  });

  it('treats an unknown fingerprint as unknown rather than as a collision', () => {
    // Zero-install participants arrive with no device row. Failing them closed
    // would cost more real supporters than it blocks fake ones.
    const noDevice = independentFive().map((c) => ({
      ...c,
      provenance: { ...c.provenance, fingerprint: null },
    }));
    const result = computeTwins(input({ candidates: noDevice }));
    expect(result.status.enabled).toBe(true);
    expect(result.status.twinCount).toBe(5);
  });

  it('does not accept the requester own second account on the same device', () => {
    const selfProvenance: AccountProvenance = {
      inviterId: null,
      fingerprint: 'my-phone',
      createdAt: iso(0),
    };
    const alt = candidate('my-alt', {}, { fingerprint: 'my-phone', createdAt: iso(90 * HOUR) });
    const result = computeTwins(
      input({ candidates: [alt, ...independentFive()], selfProvenance }),
    );

    expect(result.rejected).toContainEqual({ userId: 'my-alt', violation: 'shared_fingerprint' });
    expect(result.links.map((l) => l.twinUserId)).not.toContain('my-alt');
  });

  it('terminates on a fabricated invite cycle instead of walking forever', () => {
    const cyclic = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ]);
    // Every member of a cycle resolves to one canonical root, which makes them
    // dependent on each other rather than hanging the request.
    expect(__testing.inviteChainRoot('a', cyclic)).toBe(__testing.inviteChainRoot('b', cyclic));
    expect(__testing.inviteChainRoot('a', cyclic)).toBe(__testing.inviteChainRoot('c', cyclic));
  });

  it('gives two organic accounts two distinct roots', () => {
    const chain = new Map<string, string | null>([
      ['x', null],
      ['y', null],
    ]);
    expect(__testing.inviteChainRoot('x', chain)).not.toBe(__testing.inviteChainRoot('y', chain));
  });

  it('is deterministic across repeated calls on the same population', () => {
    const args = input();
    expect(computeTwins(args)).toEqual(computeTwins(args));
  });
});

// ---------------------------------------------------------------------------
// Cluster descriptor
// ---------------------------------------------------------------------------

describe('clusterDescriptor', () => {
  it('describes the cluster in axis language with no digits anywhere', () => {
    const twins = [nearTheta(0.1), nearTheta(-0.1), nearTheta(0.2), nearTheta(0), nearTheta(0.15)];
    const text = clusterDescriptor(sparseTheta(), twins);

    expect(text).toMatch(/^people who, like you, /);
    expect(text).not.toMatch(/\d/);
    // No metric about a person may appear, under any wording.
    expect(text.toLowerCase()).not.toContain('%');
    expect(text.toLowerCase()).not.toContain('match');
    expect(text.toLowerCase()).not.toContain('similar');
  });

  it('names the axis the cluster actually shares, on the correct pole', () => {
    const rejectSweet = new Array(AXIS_COUNT).fill(0);
    rejectSweet[4] = -2.5;
    const twins = [rejectSweet, rejectSweet, rejectSweet, rejectSweet, rejectSweet];

    expect(clusterDescriptor(rejectSweet, twins)).toBe(
      'people who, like you, will not accept sweetness in savory food',
    );
  });

  it('uses the high pole when the cluster leans the other way', () => {
    const loveHeat = new Array(AXIS_COUNT).fill(0);
    loveHeat[0] = 2.2;
    const text = clusterDescriptor(loveHeat, [loveHeat, loveHeat]);

    expect(text).toContain('chili heat');
    expect(text).toContain('seriously hot');
    expect(text).not.toContain('mild');
  });

  it('will not claim an axis the cluster is split on', () => {
    const mine = new Array(AXIS_COUNT).fill(0);
    mine[0] = 2.5;
    const opposite = new Array(AXIS_COUNT).fill(0);
    opposite[0] = -2.5;

    const text = clusterDescriptor(mine, [mine, opposite, mine]);
    // Half the cluster wants it mild. Saying "seek out chili heat" would be an
    // invented claim, which is rule 2 by the back door.
    expect(text).toBe('people whose picks line up with yours without any one axis explaining it');
  });

  it('stops at two axes rather than reading like a horoscope', () => {
    const strongEverywhere = new Array(AXIS_COUNT).fill(2);
    const text = clusterDescriptor(strongEverywhere, [strongEverywhere, strongEverywhere]);
    expect(text.split(' and ')).toHaveLength(2);
  });

  it('carries no enthusiasm markers', () => {
    const twins = [nearTheta(0.1), nearTheta(-0.1), nearTheta(0.2)];
    const text = clusterDescriptor(sparseTheta(), twins);
    expect(text).not.toContain('!');
    expect(text.toLowerCase()).not.toContain("you'll love");
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
  });

  it('is produced by computeTwins only when the channel is on', () => {
    expect(computeTwins(input()).clusterDescriptor).toMatch(/^people who/);
    expect(
      computeTwins(input({ candidates: independentFive().slice(0, 3) })).clusterDescriptor,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The client boundary. Rule 1.
// ---------------------------------------------------------------------------

describe('client boundary', () => {
  it('cannot carry reliability, cosine, weight or twin identities by type', () => {
    // Compile-time assertion, enforced by `npx tsc --noEmit`. If the never
    // guards on ClientTwinView are removed, a leaky object becomes assignable
    // and this constant stops typechecking.
    type Leaky = { status: TwinStatus; clusterDescriptor: string | null; reliability: number };
    type Verdict = Leaky extends ClientTwinView ? 'LEAKED' : 'BLOCKED';
    const verdict: Verdict = 'BLOCKED';
    expect(verdict).toBe('BLOCKED');

    type LeakyIds = { status: TwinStatus; clusterDescriptor: string | null; twinUserIds: string[] };
    type IdVerdict = LeakyIds extends ClientTwinView ? 'LEAKED' : 'BLOCKED';
    const idVerdict: IdVerdict = 'BLOCKED';
    expect(idVerdict).toBe('BLOCKED');
  });

  it('does not carry reliability at runtime either', () => {
    const distinctive = 0.913_7;
    const candidates = independentFive().map((c) => ({ ...c, reliability: distinctive }));
    const computation = computeTwins(input({ candidates }));

    // The internal shape must actually hold the value, or this test could pass
    // for the wrong reason.
    expect(computation.links[0].reliability).toBe(distinctive);

    const view = toClientTwinView(computation);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('0.9137');
    expect(serialized).not.toContain('reliability');
    expect(serialized).not.toContain('cosine');
    expect(serialized).not.toContain('weight');
    expect(Object.keys(view).sort()).toEqual(['clusterDescriptor', 'status']);
  });

  it('carries no twin identity to the client', () => {
    const view = toClientTwinView(computeTwins(input()));
    const serialized = JSON.stringify(view);
    for (const c of independentFive()) expect(serialized).not.toContain(c.userId);
  });

  it('says nothing about twins when the channel is off', () => {
    const view = toClientTwinView(computeTwins(input({ candidates: independentFive().slice(0, 2) })));
    expect(view.status.enabled).toBe(false);
    expect(view.clusterDescriptor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Evidence packet handoff. Rule 5.
// ---------------------------------------------------------------------------

describe('twinSupportForPacket', () => {
  it('emits support when k and lift are both cleared', () => {
    const support = twinSupportForPacket(computeTwins(input()), CONSTANTS.LIFT_DELTA + 0.2);
    expect(support).toBeDefined();
    expect(support!.n).toBe(CONSTANTS.K_FLOOR);
    expect(support!.kFloorMet).toBe(true);
    expect(support!.clusterDescriptor).toMatch(/^people who/);
  });

  it('emits nothing when lift is at or below the delta', () => {
    // At the delta exactly: the rule is strictly greater than. If everyone likes
    // it, it is a billboard, not word of mouth.
    expect(twinSupportForPacket(computeTwins(input()), CONSTANTS.LIFT_DELTA)).toBeUndefined();
    expect(twinSupportForPacket(computeTwins(input()), 0.01)).toBeUndefined();
  });

  it('emits nothing when the twin channel never fired', () => {
    const thin = computeTwins(input({ candidates: independentFive().slice(0, 3) }));
    expect(twinSupportForPacket(thin, 0.9)).toBeUndefined();
  });

  it('emits nothing for an astroturf ring even at enormous lift', () => {
    // The whole attack: five fake accounts all rating one dish positively
    // produces a huge lift. The k floor with independence is what stops it.
    const ringed = computeTwins(input({ candidates: ring(() => ({ fingerprint: 'one-laptop' })) }));
    expect(twinSupportForPacket(ringed, 0.95)).toBeUndefined();
  });
});
