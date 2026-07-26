/**
 * Reset the demo to a clean state. Track C.
 *
 *   npx tsx scripts/seed/reset.ts
 *
 * One command, safe to run between rehearsals and between judge groups. It
 * has to be fast and idempotent: fast because it runs live between demo
 * slots, idempotent because "did I already reset?" is not a question anyone
 * wants to answer under time pressure.
 *
 * HOW IT KNOWS WHAT TO DELETE WITHOUT A MANIFEST
 * population.ts derives every id deterministically from a stable key
 * (seedUuid), so populationIdentifiers(options) recomputes, in milliseconds,
 * the exact ids seed.ts would have written for those same options, with none
 * of the duel generation or theta fitting that producing the full rows would
 * cost. Deleting by that id list is exact: no LIKE pattern, no guessing which
 * rows are "probably" seeded, no risk of a coincidental real handle matching
 * a wildcard. If a seed run used non-default options, pass the SAME options
 * here. The common case needs no argument on either side: both seedDemo and
 * resetDemo fall back to population.ts's own DEFAULTS when called with none.
 *
 * DELETE ORDER
 * Users first. duels, devices, prefs, palate_region, reliability, and
 * packets all reference users(id) with ON DELETE CASCADE in
 * contracts/schema.sql, so deleting the seeded users alone removes every
 * seeded duel regardless of which dish it points at. Venues come after:
 * dishes reference venues(id) with ON DELETE CASCADE, so deleting the seeded
 * venues removes their dishes in the same statement. Doing this in the
 * opposite order would try to delete a dish a duel still (briefly) points at
 * and fail on the schema's own foreign key.
 */

import { fileURLToPath } from 'node:url';
import { getServiceClient, hasServiceRoleCredentials } from '../../lib/db';
import { populationIdentifiers, type PopulationOptions } from './population';
import { clearDemoStore } from './store';

export interface ResetResult {
  clearedInMemory: boolean;
  deletedFromDatabase: boolean;
  counts: { users: number; venues: number };
}

/**
 * Delete every row belonging to the given ids from Supabase.
 *
 * Guarantees: users are removed before venues (see file doc for why the order
 * matters), and an empty id list produces no query at all rather than a
 * `.in('id', [])` call, which some Postgres drivers turn into a full-table
 * predicate instead of a no-op.
 */
async function deleteFromSupabase(userIds: string[], venueIds: string[]): Promise<void> {
  const client = getServiceClient();

  if (userIds.length > 0) {
    const { error } = await client.from('users').delete().in('id', userIds);
    if (error) throw new Error(`Resetting users failed: ${error.message}`);
  }

  if (venueIds.length > 0) {
    const { error } = await client.from('venues').delete().in('id', venueIds);
    if (error) throw new Error(`Resetting venues failed: ${error.message}`);
  }
}

/**
 * Reset the demo.
 *
 * Guarantees: the in-memory store (store.ts) is empty when this resolves,
 * unconditionally. When a service-role credential exists, every row this
 * project's seed generator could have produced for `options` is also removed
 * from Supabase. Calling this twice in a row, or calling it when nothing was
 * ever seeded, succeeds both times: deleting an id that is not present is not
 * an error in SQL, and clearDemoStore() is defined to be a no-op on an empty
 * store.
 *
 * `options` must match whatever `seedDemo(options)` was actually called with.
 * The default on both sides is the same object, so the common case, "reset
 * the standard demo population", needs no argument on either side.
 */
export async function resetDemo(options: PopulationOptions = {}): Promise<ResetResult> {
  const { userIds, venueIds } = populationIdentifiers(options);

  clearDemoStore();

  let deletedFromDatabase = false;
  if (hasServiceRoleCredentials()) {
    await deleteFromSupabase(userIds, venueIds);
    deletedFromDatabase = true;
  }

  return {
    clearedInMemory: true,
    deletedFromDatabase,
    counts: { users: userIds.length, venues: venueIds.length },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/** See seed.ts's isDirectlyExecuted for why this is how a CLI entry point is guarded here. */
function isDirectlyExecuted(): boolean {
  try {
    return typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isDirectlyExecuted()) {
  resetDemo()
    .then((result) => {
      console.log(
        `Reset ${result.counts.users} seeded users and ${result.counts.venues} seeded venues. ` +
          `In-memory store: cleared. Database: ${
            result.deletedFromDatabase ? 'cleared' : 'skipped, no service-role credential'
          }.`,
      );
    })
    .catch((err) => {
      console.error('Reset failed:', err);
      process.exitCode = 1;
    });
}
