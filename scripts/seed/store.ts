/**
 * The in-memory demo store. Track C.
 *
 * "Must work with no database configured" (the seed task's own requirement)
 * means something has to hold the seeded population when
 * SUPABASE_SERVICE_ROLE_KEY does not exist. This module is that something.
 * seed.ts writes to it unconditionally, before it even checks for
 * credentials, so the demo is never blocked on Supabase being reachable.
 *
 * WHY A MODULE-LEVEL SINGLETON RATHER THAN A CLASS A CALLER INSTANTIATES
 * Every script invocation and every request in a given Next.js server process
 * needs to see the SAME seeded population without threading it through every
 * function signature, the same way lib/db/client.ts caches one client per
 * process rather than handing callers a constructor. It is not durable across
 * a process restart. That is intentional: seed.ts and reset.ts are the two
 * commands a rehearsal runs before and after itself, not a database.
 */

import { SEED_PREFIX, type SeededPopulation } from './population';

interface DemoStore {
  population: SeededPopulation | null;
  seededAt: string | null;
}

const store: DemoStore = { population: null, seededAt: null };

/** Replace the store's contents. The only writer besides clearDemoStore. */
export function setDemoPopulation(population: SeededPopulation, seededAt: string = new Date().toISOString()): void {
  store.population = population;
  store.seededAt = seededAt;
}

/** The current seeded population, or null when nothing has been seeded in this process. */
export function getDemoPopulation(): SeededPopulation | null {
  return store.population;
}

/** When the current population was seeded, or null when the store is empty. */
export function getDemoSeededAt(): string | null {
  return store.seededAt;
}

/**
 * Empty the store.
 *
 * Guarantees: idempotent. Calling this on an already-empty store is a no-op,
 * not an error, because reset.ts has to be safe to run between every
 * rehearsal whether or not a seed run happened first.
 */
export function clearDemoStore(): void {
  store.population = null;
  store.seededAt = null;
}

/**
 * Whether a handle or fingerprint was produced by the seed generator.
 *
 * This is the reachable half of "every seeded record must be flagged":
 * contracts/schema.sql is frozen and carries no is_seeded column, so the flag
 * lives in the shape of the identifier instead. See population.ts's
 * SEED_PREFIX doc for the full mapping, including why duels use their own
 * native `surface: 'demo'` field instead of this prefix.
 */
export function isSeededHandle(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && handle.startsWith(SEED_PREFIX);
}

/** Re-exported so a caller checking `isSeededHandle` never has to import population.ts too. */
export { SEED_PREFIX };
