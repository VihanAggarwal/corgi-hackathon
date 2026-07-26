/**
 * Seed the demo. Track C.
 *
 *   npx tsx scripts/seed/seed.ts
 *
 * Generates a small, coherent synthetic population (population.ts) and loads
 * it into the in-memory demo store, always, plus Supabase when
 * SUPABASE_SERVICE_ROLE_KEY is set. Never throws for a missing key, the same
 * pattern core/render.ts and scripts/corpus/extract.ts use: there is no
 * .env.local guaranteed to exist, and the demo has to run today regardless.
 *
 * IDEMPOTENT BY CONSTRUCTION
 * Every id population.ts produces is a deterministic function of a stable
 * key, not gen_random_uuid(). Running this script twice against the same
 * database upserts the same rows rather than duplicating the population, so
 * forgetting to call reset.ts before a rehearsal does not double the room.
 */

import { fileURLToPath } from 'node:url';
import { getServiceClient, hasServiceRoleCredentials } from '../../lib/db';
import { generatePopulation, type PopulationOptions, type SeededPopulation } from './population';
import { setDemoPopulation } from './store';

export interface SeedResult {
  population: SeededPopulation;
  wroteToDatabase: boolean;
  counts: {
    archetypes: number;
    venues: number;
    dishes: number;
    users: number;
    duels: number;
  };
}

function summarize(p: SeededPopulation): SeedResult['counts'] {
  return {
    archetypes: p.archetypes.length,
    venues: p.venues.length,
    dishes: p.dishes.length,
    users: p.users.length,
    duels: p.duels.length,
  };
}

/** Duels are the largest table by far. Batched so one request stays well under Supabase's payload limits. */
const DUEL_BATCH_SIZE = 500;

function throwOnError(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`Seeding ${context} failed: ${error.message}`);
}

/**
 * Write a population to Supabase.
 *
 * Guarantees: venues and dishes land before anything that references them,
 * users land before their devices, prefs, and reliability rows, and every
 * write is an upsert on the row's primary key, so a second run with the same
 * options mutates the same rows instead of duplicating them. Throws on the
 * first failure rather than continuing partially, because a half-written
 * population is exactly the state that makes computeTwins refuse everyone on
 * stage for a reason nobody can see.
 */
async function writeToSupabase(population: SeededPopulation): Promise<void> {
  const client = getServiceClient();

  const venueRows = population.venues.map((v) => ({
    id: v.id,
    gplace_id: v.gplaceId,
    name: v.name,
    lat: v.lat,
    lng: v.lng,
    price_band: v.priceBand,
    neighborhood: v.neighborhood,
    noise_level: v.noiseLevel,
  }));
  throwOnError('venues', (await client.from('venues').upsert(venueRows)).error);

  const dishRows = population.dishes.map((d) => ({
    id: d.id,
    venue_id: d.venueId,
    name: d.name,
    description: d.description,
    price_cents: d.priceCents,
    phi: d.vector.phi,
    phi_confidence: d.vector.confidence,
    verified: d.verified,
    image_url: d.imageUrl,
    last_extracted_at: d.lastExtractedAt,
  }));
  throwOnError('dishes', (await client.from('dishes').upsert(dishRows)).error);

  const userRows = population.users.map((u) => ({
    id: u.id,
    handle: u.handle,
    created_at: u.provenance.createdAt,
  }));
  throwOnError('users', (await client.from('users').upsert(userRows)).error);

  const deviceRows = population.devices.map((d) => ({
    id: d.id,
    user_id: d.userId,
    fingerprint: d.fingerprint,
    first_seen: d.firstSeen,
  }));
  throwOnError('devices', (await client.from('devices').upsert(deviceRows)).error);

  const prefRows = population.users.map((u) => ({
    user_id: u.id,
    theta: u.fitted.theta,
    n_comparisons: u.fitted.nComparisons,
    posterior_var: u.fitted.posteriorVar,
    updated_at: u.fitted.updatedAt,
  }));
  throwOnError('prefs', (await client.from('prefs').upsert(prefRows, { onConflict: 'user_id' })).error);

  const reliabilityRows = population.users.map((u) => ({
    user_id: u.id,
    score: u.reliability,
    n_evaluated: u.fitted.nComparisons,
    updated_at: u.fitted.updatedAt,
  }));
  throwOnError(
    'reliability',
    (await client.from('reliability').upsert(reliabilityRows, { onConflict: 'user_id' })).error,
  );

  const duelRows = population.duels.map((d) => ({
    id: d.id,
    device_id: d.deviceId,
    user_id: d.userId,
    dish_a: d.dishA,
    dish_b: d.dishB,
    winner: d.winner,
    surface: d.surface,
    created_at: d.createdAt,
  }));
  for (let i = 0; i < duelRows.length; i += DUEL_BATCH_SIZE) {
    const batch = duelRows.slice(i, i + DUEL_BATCH_SIZE);
    throwOnError('duels', (await client.from('duels').upsert(batch)).error);
  }
}

/**
 * Seed the demo.
 *
 * Guarantees: the in-memory store (store.ts) holds the generated population
 * when this resolves, regardless of database credentials. When a service-role
 * credential exists, the same population is also upserted into Supabase and
 * `wroteToDatabase` is true; otherwise the function returns normally with
 * `wroteToDatabase: false` rather than throwing, because a missing key is a
 * config gap on day one of this build, not a caller error.
 */
export async function seedDemo(options: PopulationOptions = {}): Promise<SeedResult> {
  const population = generatePopulation(options);
  setDemoPopulation(population);

  let wroteToDatabase = false;
  if (hasServiceRoleCredentials()) {
    await writeToSupabase(population);
    wroteToDatabase = true;
  }

  return { population, wroteToDatabase, counts: summarize(population) };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * True only when this file is the script node/tsx was actually invoked on,
 * false when it is imported by a test or another module. process.argv[1] is
 * the entry script's path on both platforms this runs on; comparing it to
 * this module's own path is the standard ESM stand-in for CommonJS's
 * `require.main === module`, which does not exist under the "module":
 * "esnext" this repo builds with.
 */
function isDirectlyExecuted(): boolean {
  try {
    return typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isDirectlyExecuted()) {
  seedDemo()
    .then((result) => {
      const { counts } = result;
      console.log(
        `Seeded ${counts.users} users across ${counts.archetypes} archetypes, ` +
          `${counts.duels} duels, ${counts.dishes} dishes at ${counts.venues} venues. ` +
          `Database: ${result.wroteToDatabase ? 'written' : 'in-memory only, no service-role credential'}.`,
      );
    })
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exitCode = 1;
    });
}
