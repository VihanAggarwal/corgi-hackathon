/**
 * Prove a profile survives a cold instance.
 *
 *   npx tsx scripts/seed/persistence-check.ts
 *
 * The bug this guards: lib/store/memory.ts is a process-local Map, so on
 * Vercel a second request can land on a fresh instance and see nothing. This
 * writes duels, then simulates the cold instance by clearing the in-memory
 * store completely, and checks the profile comes back from Supabase.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { DISHES } from '../../components/mock/fixtures';
import { getOrCreateIdentity, recordDuel, resetStoreForTests } from '../../lib/store/memory';
import { hydrateIdentity, persistDuel, resetHydrationForTests } from '../../lib/store/persist';

const DEVICE = `pcheck${Date.now().toString(36)}`;
const KEY = `device:${DEVICE}`;

async function main(): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('No SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  const verified = DISHES.filter((d) => d.verified);
  if (verified.length < 4) {
    console.error('Need at least four verified dishes to fit anything.');
    process.exit(1);
  }

  console.log(`\ndevice ${DEVICE}\n`);

  // --- instance A: someone swipes -----------------------------------------
  const a = getOrCreateIdentity(KEY, DEVICE, null);
  let written = 0;
  for (let i = 0; i + 1 < verified.length; i += 2) {
    const x = verified[i];
    const y = verified[i + 1];
    recordDuel(a, x.id, y.id, x.id, 'feed');
    await persistDuel(DEVICE, x.id, y.id, x.id, 'feed');
    written++;
  }
  const before = a.nComparisons;
  console.log(`instance A: ${written} duels written, nComparisons = ${before}`);

  // --- the cold instance ---------------------------------------------------
  // Exactly what Vercel does between requests: a brand new process with an
  // empty Map and no memory of anyone.
  resetStoreForTests();
  resetHydrationForTests();

  const b = getOrCreateIdentity(KEY, DEVICE, null);
  console.log(`instance B before hydrate: nComparisons = ${b.nComparisons}`);
  await hydrateIdentity(b);
  console.log(`instance B after hydrate:  nComparisons = ${b.nComparisons}`);

  const survived = b.nComparisons === before && before > 0;
  const thetaMoved = b.theta.some((v) => Math.abs(v) > 1e-9);

  console.log('');
  console.log(survived ? 'PASS: the profile survived a cold instance.' : 'FAIL: duels were lost.');
  console.log(thetaMoved ? 'PASS: theta rebuilt from the replayed duels.' : 'FAIL: theta is still zero.');
  console.log('');

  if (!survived || !thetaMoved) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
