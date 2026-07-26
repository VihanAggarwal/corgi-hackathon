/**
 * Durable duel storage. Track C.
 *
 * WHY THIS EXISTS
 * lib/store/memory.ts is a process-local Map. On Vercel that means a second
 * request can land on a different serverless instance and see nothing: a
 * person swiped twelve dishes, texted the agent, and their profile was
 * genuinely gone. Measured, not theorized: nComparisons went 10, then 8 after
 * eight more swipes, because the instance changed underneath.
 *
 * WHAT IS PERSISTED, AND WHAT IS NOT
 * Only the DUELS. theta, the observations, and the palate region are all
 * derived, so storing them would be storing a cache that can disagree with its
 * own source. On load the duels are replayed through the same recordDuel path
 * a live pick takes, which means a hydrated identity and a freshly swiped one
 * are computed by identical code. With tens of duels per person the replay is
 * invisible.
 *
 * THE CORPUS STAYS IN CODE
 * contracts/schema.sql's `dishes` and `venues` exist here only to satisfy the
 * foreign keys on `duels`. Dish attributes are still read from the fixture
 * corpus, because two sources for the same twenty dishes is exactly the drift
 * lib/store/corpus.ts already refuses. Seeding writes ids and names, not phi.
 *
 * EVERY FUNCTION HERE IS BEST EFFORT. A database that is unreachable degrades
 * to the in-memory behavior we already had, never to a failed request: losing
 * a profile is bad, and refusing to serve a duel because a write failed is
 * worse.
 */

import { createHash } from 'node:crypto';
import { getServiceClient, hasServiceRoleCredentials } from '@/lib/db/client';
import { DISHES, VENUES } from '@/lib/store/corpus';
import { recordDuel, type StoredIdentity } from '@/lib/store/memory';
import type { DuelSurface } from '@/lib/store/memory';

/**
 * A stable UUID for a corpus id.
 *
 * The corpus uses short ids ("d1", "v3") and the schema's foreign keys are
 * uuid columns, so the two have to be bridged. This is uuid v5 in shape:
 * a namespaced SHA-1, with the version and variant bits set, so the same
 * corpus id maps to the same uuid on every machine and every deploy without
 * anyone storing a mapping table.
 */
export function corpusUuid(kind: 'dish' | 'venue', id: string): string {
  const h = createHash('sha1').update(`tastetwins:${kind}:${id}`).digest('hex');
  const version = (parseInt(h.slice(12, 14), 16) & 0x0f) | 0x50;
  const variant = (parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80;
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    version.toString(16).padStart(2, '0') + h.slice(14, 16),
    variant.toString(16).padStart(2, '0') + h.slice(18, 20),
    h.slice(20, 32),
  ].join('-');
}

const DISH_UUID = new Map<string, string>();
const UUID_DISH = new Map<string, string>();
for (const d of DISHES) {
  const u = corpusUuid('dish', d.id);
  DISH_UUID.set(d.id, u);
  UUID_DISH.set(u, d.id);
}

function persistenceEnabled(): boolean {
  return hasServiceRoleCredentials();
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Write the corpus into `venues` and `dishes` so duel foreign keys resolve.
 *
 * Idempotent by construction: ids are deterministic and the write is an upsert,
 * so running it twice changes nothing. Returns false when there is no database
 * rather than throwing, because every caller is on a path that must still work
 * without one.
 */
export async function seedCorpusRows(): Promise<boolean> {
  if (!persistenceEnabled()) return false;
  const db = getServiceClient();

  const venueRows = VENUES.map((v) => ({
    id: corpusUuid('venue', v.id),
    gplace_id: `corpus:${v.id}`,
    name: v.name,
    lat: v.lat,
    lng: v.lng,
    price_band: v.priceBand,
    neighborhood: v.neighborhood,
  }));
  const { error: vErr } = await db.from('venues').upsert(venueRows, { onConflict: 'id' });
  if (vErr) return false;

  // phi is deliberately omitted: attributes live in the fixture corpus, and
  // these rows exist for referential integrity only. See the file header.
  const dishRows = DISHES.map((d) => ({
    id: corpusUuid('dish', d.id),
    venue_id: corpusUuid('venue', d.venueId),
    name: d.name,
    description: d.description,
    price_cents: d.priceCents,
    verified: d.verified,
  }));
  const { error: dErr } = await db.from('dishes').upsert(dishRows, { onConflict: 'id' });
  return !dErr;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

const deviceRowCache = new Map<string, string>();

/** The `devices.id` for a fingerprint, creating the row if needed. */
async function deviceRowId(fingerprint: string): Promise<string | null> {
  const cached = deviceRowCache.get(fingerprint);
  if (cached) return cached;
  const db = getServiceClient();

  const existing = await db.from('devices').select('id').eq('fingerprint', fingerprint).maybeSingle();
  if (existing.data?.id) {
    deviceRowCache.set(fingerprint, existing.data.id);
    return existing.data.id;
  }

  const created = await db.from('devices').insert({ fingerprint }).select('id').maybeSingle();
  if (created.data?.id) {
    deviceRowCache.set(fingerprint, created.data.id);
    return created.data.id;
  }

  // Lost a race with a concurrent insert on the unique fingerprint. Read again.
  const retry = await db.from('devices').select('id').eq('fingerprint', fingerprint).maybeSingle();
  if (retry.data?.id) {
    deviceRowCache.set(fingerprint, retry.data.id);
    return retry.data.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Duels
// ---------------------------------------------------------------------------

/**
 * Record one duel durably. Never throws, and never blocks correctness: a
 * failed write costs this pick on a future instance, not this request.
 */
export async function persistDuel(
  fingerprint: string,
  dishA: string,
  dishB: string,
  winner: string,
  surface: DuelSurface,
): Promise<void> {
  if (!persistenceEnabled()) return;
  const a = DISH_UUID.get(dishA);
  const b = DISH_UUID.get(dishB);
  const w = DISH_UUID.get(winner);
  // A dish outside the corpus has no row to point at. Skipping is correct:
  // the FK would reject it anyway, and a menu-photo dish is not corpus data.
  if (!a || !b || !w) return;

  try {
    const deviceId = await deviceRowId(fingerprint);
    if (!deviceId) return;
    await getServiceClient()
      .from('duels')
      .insert({ device_id: deviceId, dish_a: a, dish_b: b, winner: w, surface });
  } catch {
    // Intentionally silent. See the file header on best effort.
  }
}

/** Identities already replayed in this process, so a second call is a no-op. */
const hydrated = new Set<string>();

/**
 * Rebuild an identity from its stored duels.
 *
 * Only runs when the in-memory record is empty, which is exactly the cold
 * instance case this file exists for. A warm instance already holds the truth
 * and replaying would double count it.
 */
export async function hydrateIdentity(identity: StoredIdentity): Promise<StoredIdentity> {
  if (!persistenceEnabled()) return identity;
  if (hydrated.has(identity.key)) return identity;
  if (identity.nComparisons > 0) {
    hydrated.add(identity.key);
    return identity;
  }
  const fingerprint = identity.fingerprint ?? identity.deviceId;
  if (!fingerprint) return identity;

  hydrated.add(identity.key);

  try {
    const db = getServiceClient();
    const device = await db.from('devices').select('id').eq('fingerprint', fingerprint).maybeSingle();
    if (!device.data?.id) return identity;

    const { data } = await db
      .from('duels')
      .select('dish_a, dish_b, winner, surface, created_at')
      .eq('device_id', device.data.id)
      .order('created_at', { ascending: true })
      .limit(500);

    for (const row of data ?? []) {
      const a = UUID_DISH.get(row.dish_a as string);
      const b = UUID_DISH.get(row.dish_b as string);
      const w = UUID_DISH.get(row.winner as string);
      if (!a || !b || !w) continue;
      // The same path a live pick takes, so a hydrated profile and a freshly
      // swiped one are produced by identical code rather than two fits that
      // have to be kept in agreement.
      recordDuel(identity, a, b, w, (row.surface as DuelSurface) ?? 'feed');
    }
  } catch {
    // A hydration failure leaves an empty profile, which reads as "not
    // calibrated yet". Wrong, but honest and recoverable, unlike a 500.
  }

  return identity;
}

/** Test hook: forget which identities were replayed. */
export function resetHydrationForTests(): void {
  hydrated.clear();
  deviceRowCache.clear();
}
