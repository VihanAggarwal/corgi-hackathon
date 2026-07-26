/**
 * resetDemo tests. Track C.
 *
 * lib/db is mocked the same way seed.test.ts mocks it: a real tiny table
 * store, never the live Supabase project .env.local happens to point at. The
 * round-trip tests here (seed, then reset, then assert nothing is left) are
 * the actual guarantee the task asked for: reset returns the demo to a clean
 * state in one command, and it is safe to call twice.
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
const { resetDemo } = await import('./reset');
const { populationIdentifiers } = await import('./population');

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
  it('still clears the in-memory store', async () => {
    dbMock.__setHasCreds(false);
    await seedDemo(SMALL);
    expect(getDemoPopulation()).not.toBeNull();

    const result = await resetDemo(SMALL);

    expect(result.clearedInMemory).toBe(true);
    expect(result.deletedFromDatabase).toBe(false);
    expect(getDemoPopulation()).toBeNull();
  });

  it('is a no-op, not an error, when nothing was ever seeded', async () => {
    await expect(resetDemo(SMALL)).resolves.toMatchObject({ clearedInMemory: true });
  });
});

describe('with a service-role credential', () => {
  beforeEach(() => {
    dbMock.__setHasCreds(true);
  });

  it('deletes every row a matching seedDemo call wrote', async () => {
    await seedDemo(SMALL);
    const t = dbMock.__client.tables;
    expect(t.get('users')?.rows.size).toBeGreaterThan(0);
    expect(t.get('venues')?.rows.size).toBeGreaterThan(0);
    expect(t.get('duels')?.rows.size).toBeGreaterThan(0);
    expect(t.get('dishes')?.rows.size).toBeGreaterThan(0);

    const result = await resetDemo(SMALL);

    expect(result.deletedFromDatabase).toBe(true);
    // Users cascade duels, devices, prefs, and reliability in the real schema
    // (contracts/schema.sql: all reference users(id) on delete cascade). The
    // fake store has no cascade, which is exactly why resetDemo deletes both
    // users AND venues explicitly rather than relying on one cascading into
    // the other.
    expect(t.get('users')?.rows.size).toBe(0);
    expect(t.get('venues')?.rows.size).toBe(0);
  });

  it('is idempotent: resetting twice in a row is not an error and stays clean', async () => {
    await seedDemo(SMALL);
    await resetDemo(SMALL);
    const second = await resetDemo(SMALL);

    expect(second.deletedFromDatabase).toBe(true);
    expect(dbMock.__client.tables.get('users')?.rows.size).toBe(0);
  });

  it('does not touch rows outside the seeded id set', async () => {
    const client = dbMock.__client;
    await client.from('users').upsert([{ id: 'real-user-not-seeded', handle: 'a_real_person' }]);

    await seedDemo(SMALL);
    await resetDemo(SMALL);

    expect(client.tables.get('users')?.rows.has('real-user-not-seeded')).toBe(true);
  });

  it('reset alone (no prior seed) recomputes the same ids and is still a clean no-op', async () => {
    const ids = populationIdentifiers(SMALL);
    const result = await resetDemo(SMALL);
    expect(result.counts.users).toBe(ids.userIds.length);
    expect(result.counts.venues).toBe(ids.venueIds.length);
  });
});
