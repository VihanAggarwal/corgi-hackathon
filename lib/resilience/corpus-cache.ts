/**
 * Local corpus cache. Track C.
 *
 * THE DUEL FEED MUST NEVER FAIL
 * Every other surface in this product needs a live model, a live database, or
 * both. The duel feed needs neither: it only needs some real dish names to put
 * in front of a person's thumb. That makes it the one surface with no excuse
 * for going blank when conference wifi drops, so it is built to read straight
 * off disk. Nothing in this file makes a network call, ever, and that is the
 * property every test below exists to prove.
 *
 * TWO SOURCES, ONE SHAPE
 * Track A's corpus pipeline writes newline-delimited JSON to
 * scripts/corpus/.checkpoints as it runs, so a demo laptop that has ever run
 * the pipeline (including its own dry-run mode) has real venue and dish data
 * sitting on disk whether or not Supabase is reachable. A laptop that has
 * never run it, or a fresh clone before hour one, has nothing there at all.
 * Both cases return the same CorpusSnapshot shape, tagged with `source`, so a
 * caller can show a "seeded" indicator without a second code path.
 *
 * BOUNDED ON PURPOSE
 * extractions.jsonl grows to one line per dish in the corpus, which the build
 * spec puts at roughly 8000. Loading all of it to serve a duel feed of a dozen
 * pairs is the kind of local slowdown that only shows up on the specific
 * laptop the demo runs on, so reads are capped: at most MAX_VENUES venues, at
 * most MAX_DISHES_PER_VENUE dishes each, and the extraction scan gives up
 * after MAX_EXTRACTION_SCAN_LINES rather than walking a corpus that grew past
 * what a hackathon needs. A dish whose extraction was never found still gets
 * served, fully masked, because a duel needs a name and a price, not a phi
 * vector.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../../contracts/axes';
import type { Dish, Venue } from '../../contracts/types';

const DEFAULT_CHECKPOINT_DIR = join(process.cwd(), 'scripts', 'corpus', '.checkpoints');

const MAX_VENUES = 60;
const MAX_DISHES_PER_VENUE = 8;
/** Defensive ceiling on how much of extractions.jsonl one load will scan. */
const MAX_EXTRACTION_SCAN_LINES = 20_000;

// ---------------------------------------------------------------------------
// Checkpoint file shapes, as scripts/corpus writes them. Read defensively:
// this file has no ownership of that pipeline and must not assume its output
// never changes shape underneath it.
// ---------------------------------------------------------------------------

interface RawVenue {
  key?: unknown;
  gplaceId?: unknown;
  name?: unknown;
  lat?: unknown;
  lng?: unknown;
  priceBand?: unknown;
  neighborhood?: unknown;
}

interface RawMenuItem {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  priceCents?: unknown;
}

interface RawMenu {
  key?: unknown;
  venueKey?: unknown;
  items?: unknown;
}

interface RawExtraction {
  key?: unknown;
  phi?: unknown;
  confidence?: unknown;
  maskedAxes?: unknown;
}

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

export interface CorpusSnapshot {
  venues: Venue[];
  dishes: Dish[];
  /** Whether this came off Track A's checkpoint files or the bundled fixture. */
  source: 'checkpoint' | 'fixture';
}

export interface OfflineDishView {
  dishId: string;
  name: string;
  venueName: string;
  neighborhood: string;
  description: string | null;
  priceCents: number | null;
}

export interface OfflineDuelPair {
  pairId: string;
  a: OfflineDishView;
  b: OfflineDishView;
}

// ---------------------------------------------------------------------------
// Line-oriented JSON reading
// ---------------------------------------------------------------------------

/**
 * Parse up to `limit` well-formed lines of a newline-delimited JSON file.
 *
 * Guarantees: never throws for a malformed individual line, a blank line, or
 * trailing whitespace. One corrupted line in an otherwise good checkpoint file
 * must not sink the whole read, because the failure mode this file exists to
 * avoid is exactly "one bad byte took down the duel feed."
 */
function readJsonlLines(path: string, limit: number): unknown[] {
  const text = readFileSync(path, 'utf8');
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (out.length >= limit) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip the bad line. See the doc comment above.
    }
  }
  return out;
}

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function clampPriceBand(v: unknown): 1 | 2 | 3 | 4 {
  const n = Math.round(asNumber(v, 2));
  return n >= 1 && n <= 4 ? (n as 1 | 2 | 3 | 4) : 2;
}

function zeroVec(): number[] {
  return new Array(AXIS_COUNT).fill(0);
}

/** Every axis, used when a dish's extraction was never found within the scan cap. */
const FULLY_MASKED: AxisKey[] = [...AXIS_KEYS];

// ---------------------------------------------------------------------------
// Checkpoint reader
// ---------------------------------------------------------------------------

/**
 * Read a CorpusSnapshot from Track A's checkpoint directory, or null.
 *
 * Returns null rather than throwing for any structural reason: the venues file
 * is missing, unreadable, or empty. A throw here would make the caller
 * responsible for a try/catch it should never have to write; null is the
 * "nothing usable here" signal the fixture fallback is built to answer.
 */
function readCheckpointSnapshot(dir: string): CorpusSnapshot | null {
  const venuesPath = join(dir, 'venues.jsonl');
  const menusPath = join(dir, 'menus.jsonl');
  const extractionsPath = join(dir, 'extractions.jsonl');

  if (!existsSync(venuesPath) || !existsSync(menusPath)) return null;

  let rawVenues: RawVenue[];
  let rawMenus: RawMenu[];
  try {
    rawVenues = readJsonlLines(venuesPath, MAX_VENUES) as RawVenue[];
    // Menus are one line per venue, so the whole file is read to find matches
    // for the venues kept above regardless of line order.
    rawMenus = readJsonlLines(menusPath, MAX_VENUES * 20) as RawMenu[];
  } catch {
    return null;
  }
  if (rawVenues.length === 0) return null;

  const venues: Venue[] = [];
  const venueKeys = new Set<string>();
  for (const rv of rawVenues) {
    const key = asString(rv.key);
    if (key.length === 0) continue;
    venueKeys.add(key);
    venues.push({
      id: key,
      gplaceId: typeof rv.gplaceId === 'string' ? rv.gplaceId : null,
      name: asString(rv.name, key),
      lat: asNumber(rv.lat, 0),
      lng: asNumber(rv.lng, 0),
      priceBand: clampPriceBand(rv.priceBand),
      neighborhood: asString(rv.neighborhood, ''),
      noiseLevel: null,
    });
  }
  if (venues.length === 0) return null;

  const menuByVenueKey = new Map<string, RawMenuItem[]>();
  for (const rm of rawMenus) {
    const venueKey = asString(rm.venueKey);
    if (!venueKeys.has(venueKey)) continue;
    const items = Array.isArray(rm.items) ? (rm.items as RawMenuItem[]) : [];
    menuByVenueKey.set(venueKey, items.slice(0, MAX_DISHES_PER_VENUE));
  }

  // dishKey -> { venueKey, name, description, priceCents }, in the order we
  // want them served, which is also the order the extraction scan below uses
  // to know when it can stop early.
  const wantedItems: Array<{ key: string; venueKey: string; name: string; description: string | null; priceCents: number | null }> = [];
  for (const venue of venues) {
    const items = menuByVenueKey.get(venue.id) ?? [];
    for (const item of items) {
      const key = asString(item.key);
      const name = asString(item.name);
      if (key.length === 0 || name.length === 0) continue;
      wantedItems.push({
        key,
        venueKey: venue.id,
        name,
        description: typeof item.description === 'string' ? item.description : null,
        priceCents: typeof item.priceCents === 'number' && Number.isFinite(item.priceCents) ? item.priceCents : null,
      });
    }
  }
  if (wantedItems.length === 0) return null;

  const extractionByKey = new Map<string, { phi: number[]; confidence: number[]; maskedAxes: AxisKey[] }>();
  const wantedKeys = new Set(wantedItems.map((i) => i.key));
  if (existsSync(extractionsPath)) {
    try {
      readExtractionsInto(extractionsPath, wantedKeys, extractionByKey);
    } catch {
      // Names and prices still work with no extraction data at all; every
      // dish below falls back to a fully masked vector.
    }
  }

  const dishes: Dish[] = wantedItems.map((item) => {
    const found = extractionByKey.get(item.key);
    return {
      id: item.key,
      venueId: item.venueKey,
      name: item.name,
      description: item.description,
      priceCents: item.priceCents,
      vector: {
        phi: found?.phi ?? zeroVec(),
        confidence: found?.confidence ?? zeroVec(),
        maskedAxes: found?.maskedAxes ?? FULLY_MASKED,
      },
      // This pool has never been hand-verified. Hard rule 7: calibration reads
      // verified=true only, and nothing in a checkpoint file has been checked
      // by a human, so it can never be marked true here.
      verified: false,
      imageUrl: null,
      // No extraction timestamp travels with a checkpoint line. Claiming one
      // would assert a freshness this cache has no way to know.
      lastExtractedAt: new Date(0).toISOString(),
    };
  });

  return { venues, dishes, source: 'checkpoint' };
}

/**
 * Scan extractions.jsonl for the keys in `wanted`, writing matches into `out`.
 *
 * Stops as soon as every wanted key has been found, or after
 * MAX_EXTRACTION_SCAN_LINES lines, whichever comes first. The file is one line
 * per dish across the WHOLE corpus (thousands, per the build spec), and this
 * cache only ever needs a few hundred of them.
 */
function readExtractionsInto(
  path: string,
  wanted: Set<string>,
  out: Map<string, { phi: number[]; confidence: number[]; maskedAxes: AxisKey[] }>,
): void {
  const text = readFileSync(path, 'utf8');
  let scanned = 0;
  let remaining = wanted.size;

  for (const line of text.split(/\r?\n/)) {
    if (remaining <= 0 || scanned >= MAX_EXTRACTION_SCAN_LINES) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    scanned += 1;

    let parsed: RawExtraction;
    try {
      parsed = JSON.parse(trimmed) as RawExtraction;
    } catch {
      continue;
    }
    const key = asString(parsed.key);
    if (!wanted.has(key) || out.has(key)) continue;

    const phi = Array.isArray(parsed.phi) && parsed.phi.length === AXIS_COUNT
      ? (parsed.phi as number[]).map((v) => (Number.isFinite(v) ? v : 0))
      : zeroVec();
    const confidence = Array.isArray(parsed.confidence) && parsed.confidence.length === AXIS_COUNT
      ? (parsed.confidence as number[]).map((v) => (Number.isFinite(v) ? v : 0))
      : zeroVec();
    const maskedAxes = Array.isArray(parsed.maskedAxes)
      ? (parsed.maskedAxes as unknown[]).filter((v): v is AxisKey => AXIS_KEYS.includes(v as AxisKey))
      : FULLY_MASKED;

    out.set(key, { phi, confidence, maskedAxes });
    remaining -= 1;
  }
}

// ---------------------------------------------------------------------------
// Bundled fixture: the floor under the floor. Used when the checkpoint
// directory does not exist yet (a fresh clone before the corpus pipeline has
// ever run) or fails to yield a single usable dish. Small and self-contained
// on purpose: it must not depend on Track B's fixtures, because a resilience
// fallback that imports from the surface it is backing up is not a fallback.
// ---------------------------------------------------------------------------

const FIXTURE_VENUES: Venue[] = [
  { id: 'fx-v1', gplaceId: null, name: 'Corner Noodle House', lat: 40.715, lng: -73.99, priceBand: 1, neighborhood: 'Offline Fixture', noiseLevel: null },
  { id: 'fx-v2', gplaceId: null, name: 'Il Piccolo Forno', lat: 40.716, lng: -73.989, priceBand: 2, neighborhood: 'Offline Fixture', noiseLevel: null },
  { id: 'fx-v3', gplaceId: null, name: 'Sunset Kabab', lat: 40.717, lng: -73.988, priceBand: 1, neighborhood: 'Offline Fixture', noiseLevel: null },
];

function fixtureVector(seed: number): Dish['vector'] {
  const phi = zeroVec();
  const confidence = zeroVec();
  // A handful of driven axes with real confidence, so a caller rendering a
  // duel card off the fixture has something other than flat zeros to show.
  const driven = [seed % AXIS_COUNT, (seed + 5) % AXIS_COUNT, (seed + 11) % AXIS_COUNT];
  for (const i of driven) {
    phi[i] = ((seed * 37 + i * 13) % 7) - 3;
    confidence[i] = 0.7;
  }
  const maskedAxes = AXIS_KEYS.filter((_, i) => !driven.includes(i));
  return { phi, confidence, maskedAxes };
}

function fixtureDish(id: string, venueId: string, name: string, description: string, priceCents: number, seed: number): Dish {
  return {
    id,
    venueId,
    name,
    description,
    priceCents,
    vector: fixtureVector(seed),
    verified: false,
    imageUrl: null,
    lastExtractedAt: new Date(0).toISOString(),
  };
}

const FIXTURE_DISHES: Dish[] = [
  fixtureDish('fx-d1', 'fx-v1', 'Cold sesame noodles', 'chilled wheat noodles, sesame paste, cucumber', 1200, 1),
  fixtureDish('fx-d2', 'fx-v1', 'Hot and sour soup', 'white pepper, black vinegar, wood ear', 900, 2),
  fixtureDish('fx-d3', 'fx-v1', 'Scallion pancake', 'pan-fried, flaky layers', 700, 3),
  fixtureDish('fx-d4', 'fx-v2', 'Cacio e pepe', 'pecorino, black pepper, tonnarelli', 1600, 4),
  fixtureDish('fx-d5', 'fx-v2', 'Burrata', 'olive oil, grilled bread', 1400, 5),
  fixtureDish('fx-d6', 'fx-v2', 'Affogato', 'espresso, vanilla gelato', 800, 6),
  fixtureDish('fx-d7', 'fx-v3', 'Chapli kabab', 'ground beef, coriander seed, flat and crisp', 1300, 7),
  fixtureDish('fx-d8', 'fx-v3', 'Bolani', 'griddled flatbread, leek and potato', 900, 8),
  fixtureDish('fx-d9', 'fx-v3', 'Kabuli pulao', 'basmati, carrot, raisin, lamb', 1500, 9),
];

function cloneFixtureSnapshot(): CorpusSnapshot {
  return {
    venues: FIXTURE_VENUES.map((v) => ({ ...v })),
    dishes: FIXTURE_DISHES.map((d) => ({ ...d, vector: { ...d.vector, phi: [...d.vector.phi], confidence: [...d.vector.confidence], maskedAxes: [...d.vector.maskedAxes] } })),
    source: 'fixture',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cached: CorpusSnapshot | null = null;

export interface CorpusCacheOptions {
  /** Overridden by tests. Defaults to scripts/corpus/.checkpoints under cwd. */
  checkpointDir?: string;
  /** Re-read from disk even if a snapshot is already cached. */
  forceRefresh?: boolean;
}

/**
 * The corpus the duel feed serves from, offline-first.
 *
 * Guarantees: never throws, never makes a network call, and never returns an
 * empty snapshot. Prefers Track A's checkpoint files; falls back to the
 * bundled fixture the moment those files are absent, empty, or yield zero
 * dishes. The result is cached in memory after the first successful read of
 * the default directory, because re-parsing a multi-megabyte checkpoint file
 * on every duel request is the kind of thing that only shows up as latency
 * once someone is standing at a demo table.
 */
export function getOfflineCorpusSnapshot(options: CorpusCacheOptions = {}): CorpusSnapshot {
  const usingDefaultDir = options.checkpointDir === undefined;
  if (cached && usingDefaultDir && !options.forceRefresh) return cached;

  const dir = options.checkpointDir ?? DEFAULT_CHECKPOINT_DIR;
  let snapshot: CorpusSnapshot | null = null;
  try {
    snapshot = readCheckpointSnapshot(dir);
  } catch {
    snapshot = null;
  }

  const result = snapshot && snapshot.dishes.length > 0 ? snapshot : cloneFixtureSnapshot();
  if (usingDefaultDir) cached = result;
  return result;
}

/** Drop the in-memory snapshot. Tests, and a presenter who reruns the corpus pipeline mid-conference. */
export function resetOfflineCorpusCache(): void {
  cached = null;
}

function toView(dish: Dish, venueById: Map<string, Venue>): OfflineDishView {
  const venue = venueById.get(dish.venueId);
  return {
    dishId: dish.id,
    name: dish.name,
    venueName: venue?.name ?? 'Unknown venue',
    neighborhood: venue?.neighborhood ?? '',
    description: dish.description,
    priceCents: dish.priceCents,
  };
}

/**
 * A deterministic block of duel pairs from a snapshot.
 *
 * Guarantees: pure and deterministic for a given (snapshot, count, seed), so
 * two requests for the same seed serve the same feed, and repeats appear only
 * once every `dishes.length` pairs have been exhausted. Returns an empty array
 * only when the snapshot has fewer than two dishes, which getOfflineCorpusSnapshot
 * never itself produces.
 */
export function sampleDuelPairs(snapshot: CorpusSnapshot, count: number, seed = 0): OfflineDuelPair[] {
  const n = snapshot.dishes.length;
  if (n < 2 || count <= 0) return [];

  const venueById = new Map(snapshot.venues.map((v) => [v.id, v]));
  const out: OfflineDuelPair[] = [];

  for (let i = 0; i < count; i++) {
    const ia = (i * 2 + seed) % n;
    let ib = (i * 2 + 1 + seed) % n;
    if (ib === ia) ib = (ib + 1) % n;
    // Alternate which side carries the earlier index so the answer is never
    // "always the left dish", matching the pattern components/data uses for
    // the seeded feed.
    const flip = (i + seed) % 3 === 1;
    const first = flip ? ib : ia;
    const second = flip ? ia : ib;

    out.push({
      pairId: `offline_${seed}_${i}`,
      a: toView(snapshot.dishes[first], venueById),
      b: toView(snapshot.dishes[second], venueById),
    });
  }

  return out;
}

export const __testing = { readCheckpointSnapshot, cloneFixtureSnapshot, DEFAULT_CHECKPOINT_DIR };
