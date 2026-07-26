/**
 * Seeded population tests. Track C.
 *
 * The subject is not "does the generator run", it is "does the population it
 * produces actually clear Track A's own gates". Every twin assertion below
 * runs the real computeTwins from '@/core', not a reimplementation, because a
 * hand-rolled cosine check here could pass while the real gate refuses
 * everyone on stage.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_COUNT } from '../../contracts/axes';
import { CONSTANTS } from '../../contracts/types';
import { computeTwins, cosineSimilarity, type TwinCandidate, type TwinComputationInput } from '../../core';
import {
  ARCHETYPES,
  generatePopulation,
  populationIdentifiers,
  seedUuid,
  SEED_PREFIX,
  __testing,
  type SeededPopulation,
} from './population';

// Fitting 24-axis Bradley-Terry for ~40 seeded users is real work; a shared
// population keeps the suite fast without weakening any assertion, since
// every test below only reads it.
const POPULATION: SeededPopulation = generatePopulation();

function candidateFor(u: SeededPopulation['users'][number]): TwinCandidate {
  return {
    userId: u.id,
    theta: u.fitted.theta,
    nComparisons: u.fitted.nComparisons,
    reliability: u.reliability,
    provenance: u.provenance,
  };
}

function twinsFor(self: SeededPopulation['users'][number], population: SeededPopulation) {
  const input: TwinComputationInput = {
    self: { userId: self.id, theta: self.fitted.theta, nComparisons: self.fitted.nComparisons },
    selfProvenance: self.provenance,
    candidates: population.users.filter((u) => u.id !== self.id).map(candidateFor),
  };
  return computeTwins(input);
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

// fitTheta stamps `updatedAt` with the wall clock (core/model.ts), which is
// the one field two calls of generatePopulation can legitimately disagree on
// a millisecond apart. Every other field, including every id and every fitted
// theta component, is a pure function of `options`.
function stableStringify(p: SeededPopulation): string {
  return JSON.stringify(p, (key, value) => (key === 'updatedAt' ? undefined : value));
}

describe('determinism', () => {
  it('produces byte-identical output for the same options', () => {
    const a = generatePopulation({ usersPerArchetype: 3, duelsPerUser: 30, archetypeCount: 2 });
    const b = generatePopulation({ usersPerArchetype: 3, duelsPerUser: 30, archetypeCount: 2 });
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('changes output when the seed changes', () => {
    const a = generatePopulation({ usersPerArchetype: 3, duelsPerUser: 20, seed: 1 });
    const b = generatePopulation({ usersPerArchetype: 3, duelsPerUser: 20, seed: 2 });
    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });

  it('populationIdentifiers matches the ids generatePopulation actually produced', () => {
    const options = { usersPerArchetype: 4, archetypeCount: 3, dishPoolSize: 12, venueCount: 5 };
    const full = generatePopulation(options);
    const ids = populationIdentifiers(options);

    expect(ids.userIds).toEqual(full.users.map((u) => u.id));
    expect(ids.venueIds).toEqual(full.venues.map((v) => v.id));
    expect(ids.dishIds).toEqual(full.dishes.map((d) => d.id));
  });
});

describe('seedUuid', () => {
  const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('is syntactically a valid uuid, which is all a Postgres uuid column checks', () => {
    expect(seedUuid('user:seed_heat_seeker_00')).toMatch(UUID_V4_SHAPE);
  });

  it('is the same value every time for the same key', () => {
    expect(seedUuid('a')).toBe(seedUuid('a'));
  });

  it('differs for different keys', () => {
    expect(seedUuid('a')).not.toBe(seedUuid('b'));
  });
});

// ---------------------------------------------------------------------------
// Every seeded record is flagged
// ---------------------------------------------------------------------------

describe('every seeded record carries the seeded flag', () => {
  it('marks every user handle and device fingerprint with SEED_PREFIX', () => {
    for (const u of POPULATION.users) {
      expect(u.handle.startsWith(SEED_PREFIX)).toBe(true);
      expect(u.seeded).toBe(true);
    }
    for (const d of POPULATION.devices) {
      expect(d.fingerprint.startsWith(SEED_PREFIX)).toBe(true);
      expect(d.seeded).toBe(true);
    }
  });

  it('marks every venue gplaceId with SEED_PREFIX, leaving the display name untouched', () => {
    for (const v of POPULATION.venues) {
      expect(v.gplaceId?.startsWith(SEED_PREFIX)).toBe(true);
      expect(v.seeded).toBe(true);
    }
  });

  it('marks every dish as seeded and verified, and every dish belongs to a seeded venue', () => {
    const seededVenueIds = new Set(POPULATION.venues.map((v) => v.id));
    for (const d of POPULATION.dishes) {
      expect(d.seeded).toBe(true);
      expect(d.verified).toBe(true);
      expect(seededVenueIds.has(d.venueId)).toBe(true);
    }
  });

  it('marks every duel with the native demo surface flag from the frozen contract', () => {
    for (const duel of POPULATION.duels) {
      expect(duel.surface).toBe('demo');
    }
  });
});

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

describe('seeded users are independent by construction', () => {
  it('gives every user a unique device fingerprint', () => {
    const fingerprints = POPULATION.users.map((u) => u.provenance.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('gives every user their own invite root, so no two share an invite chain', () => {
    for (const u of POPULATION.users) expect(u.provenance.inviterId).toBeNull();
  });

  it('spaces every pair of accounts outside the twins.ts burst window', () => {
    const times = POPULATION.users.map((u) => Date.parse(u.provenance.createdAt)).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      // twins.ts's ACCOUNT_BURST_WINDOW_MS is 15 minutes; USER_SPACING_MS here
      // is deliberately more than double that margin.
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(__testing.USER_SPACING_MS);
    }
  });

  it('produces zero independence rejections among a requester and the rest of the seeded population', () => {
    const self = POPULATION.users[0];
    const computation = twinsFor(self, POPULATION);
    expect(computation.rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Twins actually form
// ---------------------------------------------------------------------------

describe('twins actually form on the seeded population', () => {
  it('clears K_FLOOR for a requester in every archetype', () => {
    for (const archetype of ARCHETYPES) {
      const self = POPULATION.users.find((u) => u.archetypeId === archetype.id);
      if (!self) throw new Error(`No seeded user for archetype ${archetype.id}`);

      const computation = twinsFor(self, POPULATION);

      expect(computation.status.enabled).toBe(true);
      expect(computation.status.twinCount).toBeGreaterThanOrEqual(CONSTANTS.K_FLOOR);
      expect(computation.clusterDescriptor).not.toBeNull();
      expect(computation.links.length).toBe(computation.status.twinCount);
    }
  });

  it('finds twins mostly from the requester\'s own archetype, not the whole population', () => {
    const self = POPULATION.users.find((u) => u.archetypeId === ARCHETYPES[0].id)!;
    const computation = twinsFor(self, POPULATION);
    expect(computation.status.enabled).toBe(true);

    const byId = new Map(POPULATION.users.map((u) => [u.id, u] as const));
    const sameArchetype = computation.links.filter(
      (l) => byId.get(l.twinUserId)?.archetypeId === self.archetypeId,
    );
    // Not a coincidence: the whole point of building latent archetypes is
    // that twins come from the shared taste cluster, not from noise.
    expect(sameArchetype.length).toBe(computation.links.length);
  });

  it('keeps within-archetype cosine on fitted theta comfortably above TWIN_COSINE_TAU', () => {
    const archetype = ARCHETYPES[0];
    const members = POPULATION.users.filter((u) => u.archetypeId === archetype.id);
    expect(members.length).toBeGreaterThanOrEqual(2);

    let minCosine = Infinity;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const c = cosineSimilarity(members[i].fitted.theta, members[j].fitted.theta);
        minCosine = Math.min(minCosine, c);
      }
    }
    expect(minCosine).toBeGreaterThan(CONSTANTS.TWIN_COSINE_TAU);
  });

  it('does not accidentally clear the gate for two DIFFERENT archetypes forced together', () => {
    // The opposite failure mode: if every archetype secretly matched every
    // other one, the k-floor gate would be meaningless. heat_seeker and
    // mild_comfort are constructed to disagree on chili heat directly, so
    // this pair is the sharpest test of that.
    const heat = POPULATION.users.find((u) => u.archetypeId === 'heat_seeker');
    const mild = POPULATION.users.find((u) => u.archetypeId === 'mild_comfort');
    expect(heat).toBeDefined();
    expect(mild).toBeDefined();
    const cosine = cosineSimilarity(heat!.fitted.theta, mild!.fitted.theta);
    expect(cosine).toBeLessThan(CONSTANTS.TWIN_COSINE_TAU);
  });
});

// ---------------------------------------------------------------------------
// Fit quality and duel volume
// ---------------------------------------------------------------------------

describe('fitted thetas are usable, not just present', () => {
  it('gives every user at least CONSTANTS.MIN_DUELS_FOR_TWINS duels in their fit', () => {
    for (const u of POPULATION.users) {
      expect(u.fitted.nComparisons).toBeGreaterThanOrEqual(CONSTANTS.MIN_DUELS_FOR_TWINS);
    }
  });

  it('fits a theta vector of the contract length for every user', () => {
    for (const u of POPULATION.users) {
      expect(u.fitted.theta).toHaveLength(AXIS_COUNT);
      expect(u.fitted.theta.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('keeps every user reliability within (0, 1], since it stands in for a rate', () => {
    for (const u of POPULATION.users) {
      expect(u.reliability).toBeGreaterThan(0);
      expect(u.reliability).toBeLessThanOrEqual(1);
    }
  });
});
