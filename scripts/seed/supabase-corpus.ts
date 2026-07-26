/**
 * Seed the corpus into Supabase so duel foreign keys resolve.
 *
 *   npx tsx scripts/seed/supabase-corpus.ts
 *
 * contracts/schema.sql types duels.dish_a as `uuid references dishes(id)`, so
 * a duel cannot be stored until the dish it names exists as a row. This writes
 * ids and names only: dish ATTRIBUTES stay in the fixture corpus, because two
 * sources for the same twenty dishes is the drift lib/store/corpus.ts already
 * refuses to create.
 *
 * Idempotent. Ids are deterministic and the write is an upsert, so running it
 * again after a redeploy or between rehearsals changes nothing.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { DISHES, VENUES } from '../../components/mock/fixtures';
import { corpusUuid, seedCorpusRows } from '../../lib/store/persist';

async function main(): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('No SUPABASE_SERVICE_ROLE_KEY. Nothing to seed.');
    process.exit(1);
  }

  console.log(`\nseeding ${VENUES.length} venues and ${DISHES.length} dishes`);
  const ok = await seedCorpusRows();

  if (!ok) {
    console.error('Seed failed. Duels will not persist until this succeeds.');
    process.exit(1);
  }

  console.log('done. sample id mapping:');
  for (const d of DISHES.slice(0, 3)) {
    console.log(`  ${d.id.padEnd(5)} ${d.name.slice(0, 34).padEnd(36)} ${corpusUuid('dish', d.id)}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
