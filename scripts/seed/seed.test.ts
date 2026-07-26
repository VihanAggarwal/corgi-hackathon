/**
 * seedDemo tests. Track C.
 *
 * lib/db is mocked here, deliberately never the real Supabase project this
 * repo's .env.local happens to point at: a test suite that reaches a live
 * database on every run is slow, flaky on conference wifi, and exactly the
 * kind of thing that seeds real rows into a shared project by accident.
 * fake-db.ts is a real (if tiny) table store, so the "wrote the right shape"
 * assertions below are checking actual upserted rows, not a mock call log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDemoStore, getDemoPopulation } from './store';

vi.mock('../../lib/db', async () => {
  const { createFakeSupabaseClient } = await import('./fake-db');
  const client = createFakeSupabaseClient();
  let hasCreds = false;
  return {
    hasServiceRoleCredentials: () => hasCreds,
    getServiceClient: () => client,
    __setHasCreds: (v: boolean) => {
      hasCreds = v;
    },
    __client: client,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbMock = (await import('../../lib/db')) as any;
const { seedDemo } = await import('./seed');

// Small options everywhere in this file: seed.test.ts is about plumbing
// (store, database branch, idempotency), not about proving twins form, which
// is population.test.ts's job with the full default population.
const SMALL = { archetypeCount: 2, usersPerArchetype: 3, duelsPerUser: 15, dishPoolSize: 10, venueCount: 3 };

beforeEach(() => {
  dbMock.__setHasCreds(false);
  dbMock.__client.tables.clear();
  clearDemoStore();
});

afterEach(() => {
  clearDemoStore();
});

describe('with no service-role credential', () => {
  it('still populates the in-memory store, never throws', async () => {
    const result = await seedDemo(SMALL);

    expect(result.wroteToDatabase).toBe(false);
    expect(getDemoPopulation()).toBe(result.population);
    expect(result.counts.users).toBe(SMALL.archetypeCount * SMALL.usersPerArchetype);
  });

  it('never calls the database client at all', async () => {
    await seedDemo(SMALL);
    expect(dbMock.__client.tables.size).toBe(0);
  });
});

describe('with a service-role credential', () => {
  beforeEach(() => {
    dbMock.__setHasCreds(true);
  });

  it('writes venues, dishes, users, devices, prefs, reliability, and duels', async () => {
    const result = await seedDemo(SMALL);

    expect(result.wroteToDatabase).toBe(true);
    const t = dbMock.__client.tables;
    expect(t.get('venues')?.rows.size).toBe(result.counts.venues);
    expect(t.get('dishes')?.rows.size).toBe(result.counts.dishes);
    expect(t.get('users')?.rows.size).toBe(result.counts.users);
    expect(t.get('devices')?.rows.size).toBe(result.counts.users);
    expect(t.get('prefs')?.rows.size).toBe(result.counts.users);
    expect(t.get('reliability')?.rows.size).toBe(result.counts.users);
    expect(t.get('duels')?.rows.size).toBe(result.counts.duels);
  });

  it('never writes a constraint value, kind, or owner: it never touches that table at all', async () => {
    await seedDemo(SMALL);
    expect(dbMock.__client.tables.has('constraints')).toBe(false);
  });

  it('marks every written duel with the demo surface flag', async () => {
    await seedDemo(SMALL);
    const duels = [...dbMock.__client.tables.get('duels')!.rows.values()];
    expect(duels.length).toBeGreaterThan(0);
    for (const d of duels) expect(d.surface).toBe('demo');
  });

  it('writes a real fitted theta, not a placeholder', async () => {
    await seedDemo(SMALL);
    const prefs = [...dbMock.__client.tables.get('prefs')!.rows.values()];
    for (const row of prefs) {
      expect(row.theta).toHaveLength(24);
      // Exactly what this user's own duels were fit on: population.test.ts is
      // where duel volume is checked against CONSTANTS.MIN_DUELS_FOR_TWINS
      // with the real, non-truncated population.
      expect(row.n_comparisons).toBe(SMALL.duelsPerUser);
    }
  });

  it('is idempotent: seeding twice upserts the same rows rather than duplicating them', async () => {
    const first = await seedDemo(SMALL);
    const second = await seedDemo(SMALL);

    expect(second.counts).toEqual(first.counts);
    const t = dbMock.__client.tables;
    expect(t.get('users')?.rows.size).toBe(first.counts.users);
    expect(t.get('duels')?.rows.size).toBe(first.counts.duels);
  });
});
