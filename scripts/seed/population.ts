/**
 * Synthetic demo population generator. Track C.
 *
 * Pure and deterministic: no I/O, no database, no network, no dependence on
 * wall-clock time unless the caller asks for it. seed.ts loads what this
 * produces into the in-memory store and, when credentials exist, into
 * Supabase. reset.ts recomputes the same ids to know what to delete. Tests
 * import it directly and run Track A's own computeTwins over the output to
 * prove the population is not decorative.
 *
 * WHY A GENERATED POPULATION RATHER THAN RANDOM VECTORS
 * core/twins.ts requires k >= CONSTANTS.K_FLOOR independent supporters at
 * cosine >= CONSTANTS.TWIN_COSINE_TAU. Twenty-four independent random axes
 * essentially never produce that: two random unit vectors in 24 dimensions
 * have an expected cosine near zero. So this file builds a small number of
 * latent taste archetypes (a handful of dominant axes each, everything else
 * near zero) and draws each synthetic user's TRUE theta as that archetype's
 * centroid plus modest per-person noise. Duels are then generated from each
 * user's true theta with Track A's own predictPreference, which is the
 * Bradley-Terry win probability, so the signal reaching fitTheta is exactly
 * the kind of noisy pairwise data a real user would produce, not a shortcut.
 *
 * WHY EVERY ID IS A DETERMINISTIC FUNCTION OF A STABLE KEY
 * gen_random_uuid() would make reset.ts guess what to delete or make it track
 * a manifest file. Deriving every id from `seedUuid(stableKey)` means running
 * this generator twice with the same options always produces the same ids, so
 * a re-seed upserts the same rows and reset.ts can recompute exactly what to
 * remove without ever having written anything down.
 */

import { AXIS_COUNT, axisIndex, type AxisKey } from '../../contracts/axes';
import type { Conf24, Dish, Venue, Vec24 } from '../../contracts/types';
import { fitTheta, predictPreference, type AccountProvenance, type FitResult } from '../../core';

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** Small seeded PRNG, same LCG shape as core/duel-select.ts's local one. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Standard normal via Box-Muller, built on the seeded uniform generator. */
function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** FNV-1a, same shape as core/render.ts and scripts/corpus/extract.ts use. */
function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hex8(seedKey: string): string {
  return fnv1a(seedKey).toString(16).padStart(8, '0');
}

/**
 * A deterministic, syntactically valid uuid derived from a stable string key.
 *
 * NOT cryptographically random and not meant to be: the property this exists
 * for is that `seedUuid('user:seed_heat_seeker_00')` returns the same value
 * every time this process, or any other process, computes it. That is what
 * lets seed.ts upsert instead of insert and reset.ts delete by id without a
 * manifest. Version and variant nibbles are set only so Postgres's uuid
 * column type accepts the value; they carry no other meaning here.
 */
export function seedUuid(key: string): string {
  const a = hex8(`${key}#a`);
  const b = hex8(`${key}#b`);
  const c = hex8(`${key}#c`);
  const d = hex8(`${key}#d`);
  const timeLow = a;
  const timeMid = b.slice(0, 4);
  const timeHiAndVersion = `4${b.slice(1, 4)}`;
  const variantByte = ((parseInt(c.slice(0, 2), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  const clockSeq = `${variantByte}${c.slice(2, 4)}`;
  const node = `${c.slice(4, 8)}${d}`;
  return `${timeLow}-${timeMid}-${timeHiAndVersion}-${clockSeq}-${node}`;
}

// ---------------------------------------------------------------------------
// Seeded-record marker
// ---------------------------------------------------------------------------

/**
 * Every seeded, human-readable identifier starts with this. It is how a
 * caller tells seeded data from real data without a schema change:
 * contracts/schema.sql is frozen and has no is_seeded column, so the flag has
 * to live somewhere the frozen schema already has room for it. `users.handle`
 * and `devices.fingerprint` are both free text with no client-facing contract
 * type carrying them (see contracts/types.ts), so a prefix there is safe:
 * nothing downstream renders it. Duels carry a stronger, native signal
 * instead: `surface: 'demo'` is already part of the frozen Duel type and
 * schema.sql's own check constraint, built for exactly this purpose. Venues
 * are marked on `gplace_id`, which already means "identity of the real place
 * this maps to" and is null for every un-mapped real venue too, so a
 * `seed_` prefixed value there is unambiguous without touching `name`, which
 * IS client-facing.
 */
export const SEED_PREFIX = 'seed_';

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

export interface Archetype {
  id: string;
  label: string;
  /** True population centroid theta. Zero on every axis this archetype has no opinion about. */
  centroid: Vec24;
}

/**
 * Each archetype leans hard on two or three axes and says nothing on the
 * rest. Two things this shape buys:
 *
 *   1. clusterDescriptor (core/twins.ts) only names an axis when the whole
 *      cluster agrees on both sign and a minimum magnitude, so a flat,
 *      undifferentiated centroid would compute twins with no describable
 *      cluster, which is honest but useless on a demo stage.
 *   2. Within-archetype cosine similarity stays comfortably above
 *      CONSTANTS.TWIN_COSINE_TAU (0.72) even after per-user noise and the
 *      estimation noise of fitting theta from a finite duel sample. See
 *      population.test.ts for the measured numbers, not just the intent.
 */
const ARCHETYPE_DEFS: Array<{ id: string; label: string; dominant: Array<[AxisKey, number]> }> = [
  {
    id: 'heat_seeker',
    label: 'heat seeker',
    dominant: [
      ['heat_capsaicin', 3.4],
      ['heat_numbing', 2.4],
      ['aromatic_spice', 1.5],
    ],
  },
  {
    id: 'funk_umami',
    label: 'funk and umami',
    dominant: [
      ['funk_ferment', 3.2],
      ['umami_depth', 2.6],
      ['bitterness', 1.4],
    ],
  },
  {
    id: 'mild_comfort',
    label: 'mild comfort',
    dominant: [
      ['heat_capsaicin', -3.2],
      ['sweetness_savory', 1.9],
      ['texture_creamy', 2.4],
    ],
  },
  {
    id: 'crunch_fresh',
    label: 'crunch and fresh herb',
    dominant: [
      ['texture_crunch', 3.3],
      ['herb_freshness', 2.7],
      ['acid', 1.6],
    ],
  },
  {
    id: 'rich_indulgent',
    label: 'rich and indulgent',
    dominant: [
      ['fat_richness', 3.4],
      ['texture_creamy', 2.5],
      ['sweetness_dessert', 1.5],
    ],
  },
];

function buildCentroid(dominant: Array<[AxisKey, number]>): Vec24 {
  const v = new Array(AXIS_COUNT).fill(0);
  for (const [key, val] of dominant) v[axisIndex(key)] = val;
  return v;
}

export const ARCHETYPES: readonly Archetype[] = ARCHETYPE_DEFS.map((d) => ({
  id: d.id,
  label: d.label,
  centroid: buildCentroid(d.dominant),
}));

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PopulationOptions {
  /** How many of ARCHETYPES to use. Clamped to [1, ARCHETYPES.length]. */
  archetypeCount?: number;
  /**
   * Users per archetype. Must exceed CONSTANTS.K_FLOOR (5) by at least one so
   * that at least one seeded user, once excluded from their own candidate
   * pool, still has k >= K_FLOOR eligible twins left in it.
   */
  usersPerArchetype?: number;
  /** Duels per user. Must clear CONSTANTS.MIN_DUELS_FOR_TWINS (25) with margin. */
  duelsPerUser?: number;
  /** Size of the synthetic verified dish pool duels are drawn from. */
  dishPoolSize?: number;
  /** Number of synthetic venues the dish pool is spread across. */
  venueCount?: number;
  /** Per-axis standard deviation of a user's true theta around its archetype centroid. */
  thetaNoiseSigma?: number;
  /** [min, max] for a user's seeded reliability, standing in for a real out-of-sample hit rate. */
  reliabilityRange?: [number, number];
  /** PRNG seed. Fixed by default so the same options always produce the same population. */
  seed?: number;
  /**
   * Reference timestamp seeded accounts count backward from. Fixed by default
   * for reproducibility: a population generated in a test run and a
   * population generated during the actual demo must be able to compare
   * equal, and "now" would make that impossible.
   */
  referenceTime?: string;
}

const DEFAULTS: Required<PopulationOptions> = {
  archetypeCount: ARCHETYPES.length,
  usersPerArchetype: 8,
  duelsPerUser: 120,
  dishPoolSize: 40,
  venueCount: 10,
  thetaNoiseSigma: 0.15,
  reliabilityRange: [0.65, 0.95],
  seed: 1337,
  referenceTime: '2026-01-01T00:00:00.000Z',
};

function resolveOptions(options: PopulationOptions): Required<PopulationOptions> {
  return { ...DEFAULTS, ...options };
}

function resolveArchetypes(count: number): Archetype[] {
  const n = clamp(Math.round(count), 1, ARCHETYPES.length);
  return ARCHETYPES.slice(0, n) as Archetype[];
}

/**
 * Accounts created inside this window of each other collapse to one actor in
 * core/twins.ts (ACCOUNT_BURST_WINDOW_MS there is 15 minutes, checked
 * pairwise between accepted supporters). This spacing is deliberately more
 * than double that, so seeded accounts stay independent even if that internal
 * tuning value grows. It is not imported directly: twins.ts exports it only
 * through __testing, which is test-only surface, not something a script
 * should depend on.
 */
const USER_SPACING_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Deterministic handle planning
// ---------------------------------------------------------------------------

interface PlannedUser {
  archetype: Archetype;
  index: number;
  handle: string;
}

/**
 * The archetype/index/handle plan for a population, with no randomness in it.
 *
 * Shared by generatePopulation and populationIdentifiers so the two can never
 * disagree about what a user's id is. Disagreement here would mean reset.ts
 * deletes the wrong rows, or none at all, which is the one bug in this file
 * that a demo would discover live rather than in a test.
 */
function plannedUsers(archetypes: readonly Archetype[], usersPerArchetype: number): PlannedUser[] {
  const plan: PlannedUser[] = [];
  for (const archetype of archetypes) {
    for (let i = 0; i < usersPerArchetype; i++) {
      plan.push({
        archetype,
        index: i,
        handle: `${SEED_PREFIX}${archetype.id}_${String(i).padStart(2, '0')}`,
      });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Venues and dishes
// ---------------------------------------------------------------------------

export interface SeedVenue extends Venue {
  seeded: true;
}

export interface SeedDish extends Dish {
  seeded: true;
}

const VENUE_NAMES = [
  'Ember and Salt', 'Low Tide Kitchen', 'Paper Lantern', 'Marrow House',
  'Verdant Table', 'Copper Pot', 'Brick Oven Social', 'Threadneedle Diner',
  'Nightshade', 'Smoke and Vine', 'Cardamom Room', 'Blue Ledger',
];

const NEIGHBORHOODS = ['Lower East Side', 'East Village', 'Chinatown', 'Nolita', 'Two Bridges'];

/** Approximate Lower East Side coordinates, jittered per venue. Not read from any live source. */
const BASE_LAT = 40.7185;
const BASE_LNG = -73.9875;

function buildVenues(rand: () => number, count: number): SeedVenue[] {
  const venues: SeedVenue[] = [];
  for (let i = 0; i < count; i++) {
    venues.push({
      id: seedUuid(`venue:${i}`),
      // Marker, not a real Google place id. See SEED_PREFIX doc for why this
      // field carries the flag instead of `name`.
      gplaceId: `${SEED_PREFIX}venue_${i}`,
      name: `${VENUE_NAMES[i % VENUE_NAMES.length]}${i >= VENUE_NAMES.length ? ` No. ${Math.floor(i / VENUE_NAMES.length) + 1}` : ''}`,
      lat: BASE_LAT + (rand() - 0.5) * 0.02,
      lng: BASE_LNG + (rand() - 0.5) * 0.02,
      priceBand: (1 + Math.floor(rand() * 4)) as 1 | 2 | 3 | 4,
      neighborhood: NEIGHBORHOODS[i % NEIGHBORHOODS.length],
      noiseLevel: Math.floor(rand() * 100),
      seeded: true,
    });
  }
  return venues;
}

const DISH_ADJECTIVES = [
  'Charred', 'Numbing', 'Bright', 'Silky', 'Crackling', 'Smoky', 'Bittersweet',
  'Herbed', 'Crimson', 'Golden', 'Midnight', 'Fermented', 'Whipped', 'Blistered',
  'Glazed', 'Sharp', 'Slow-Cooked', 'Pickled', 'Toasted', 'Cold',
];

const DISH_NOUNS = [
  'Noodles', 'Dumplings', 'Rice Bowl', 'Skewers', 'Tofu', 'Wings', 'Salad',
  'Broth', 'Flatbread', 'Custard', 'Pickles', 'Ribs', 'Congee', 'Fritters',
  'Tartare', 'Cutlet', 'Dumpling Soup', 'Buns', 'Slaw', 'Stew',
];

/**
 * Verified, fully confident phi for every axis.
 *
 * This is the synthetic diagnostic pool for the demo, standing in for the
 * hand-verified pool hard rule 7 requires. Confidence 1 everywhere (no masked
 * axes) is deliberate: masking here would only remove information from the
 * duels this file itself generates, without testing anything about the mask
 * logic, which core/model.ts and scripts/corpus/extract.ts already cover.
 */
function randomPhi(rand: () => number): { phi: Vec24; confidence: Conf24 } {
  const phi: number[] = [];
  const confidence: number[] = [];
  for (let i = 0; i < AXIS_COUNT; i++) {
    phi.push(Number(clamp((rand() - 0.5) * 6, -3, 3).toFixed(3)));
    confidence.push(1);
  }
  return { phi, confidence };
}

function buildDishPool(rand: () => number, size: number, venues: readonly SeedVenue[], referenceTime: string): SeedDish[] {
  const dishes: SeedDish[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < size; i++) {
    let name = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const adj = DISH_ADJECTIVES[Math.floor(rand() * DISH_ADJECTIVES.length)];
      const noun = DISH_NOUNS[Math.floor(rand() * DISH_NOUNS.length)];
      name = `${adj} ${noun}`;
      if (!usedNames.has(name)) break;
      name = `${name} (${i})`;
    }
    usedNames.add(name);

    const { phi, confidence } = randomPhi(rand);
    const venue = venues[i % venues.length];

    dishes.push({
      id: seedUuid(`dish:${i}`),
      venueId: venue.id,
      name,
      description: null,
      priceCents: 800 + Math.floor(rand() * 2200),
      vector: { phi, confidence, maskedAxes: [] },
      // Hard rule 7: only verified dishes may back a fitted theta. This IS
      // the demo's verified pool, so every seeded dish is verified by design.
      verified: true,
      imageUrl: null,
      lastExtractedAt: referenceTime,
      seeded: true,
    });
  }
  return dishes;
}

// ---------------------------------------------------------------------------
// Users, devices, duels
// ---------------------------------------------------------------------------

export interface SeedUser {
  id: string;
  handle: string;
  archetypeId: string;
  /** The generative ground truth theta. Never written anywhere a real user's theta would be read from; `fitted.theta` is the honest analog of that. */
  trueTheta: Vec24;
  /** What fitTheta recovered from this user's own generated duels. This is what a real prefs row would hold. */
  fitted: FitResult;
  provenance: AccountProvenance;
  /** Stands in for a real out-of-sample hit rate (schema: reliability.score). */
  reliability: number;
  seeded: true;
}

export interface SeedDevice {
  id: string;
  userId: string;
  fingerprint: string;
  firstSeen: string;
  seeded: true;
}

export interface SeedDuel {
  id: string;
  userId: string;
  deviceId: string;
  dishA: string;
  dishB: string;
  winner: string;
  /** Native flag: schema.sql already types this enum for exactly this purpose. */
  surface: 'demo';
  createdAt: string;
}

/**
 * One user's duels, drawn from their TRUE theta via Track A's own
 * predictPreference (the Bradley-Terry win probability). Using the same
 * function fitTheta's callers use elsewhere means the generated signal has
 * the same shape real signal has: noisy near p = 0.5, decisive on axes the
 * archetype cares about, and never a deterministic argmax that would make
 * the fit implausibly clean.
 */
function generateDuelsForUser(
  userId: string,
  deviceId: string,
  dishes: readonly SeedDish[],
  theta: Vec24,
  count: number,
  rand: () => number,
  accountCreatedAt: string,
): SeedDuel[] {
  const n = dishes.length;
  const baseMs = Date.parse(accountCreatedAt);
  const out: SeedDuel[] = [];

  for (let k = 0; k < count; k++) {
    const i = Math.floor(rand() * n);
    let j = Math.floor(rand() * n);
    if (j === i) j = (j + 1) % n;

    const a = dishes[i];
    const b = dishes[j];
    const p = predictPreference(theta, a.vector.phi, b.vector.phi);
    const winner = rand() < p ? a : b;

    out.push({
      id: seedUuid(`duel:${userId}:${k}`),
      userId,
      deviceId,
      dishA: a.id,
      dishB: b.id,
      winner: winner.id,
      surface: 'demo',
      // Duels happen after signup, spread over the minutes that follow. They
      // never need to clear the burst window themselves: that check is about
      // ACCOUNT creation, not duel timing.
      createdAt: new Date(baseMs + (k + 1) * 60_000).toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The population
// ---------------------------------------------------------------------------

export interface SeededPopulation {
  archetypes: Archetype[];
  venues: SeedVenue[];
  dishes: SeedDish[];
  users: SeedUser[];
  devices: SeedDevice[];
  duels: SeedDuel[];
}

/**
 * Just the ids a population's rows would have, with none of the expensive
 * generation (duel sampling, gradient-descent fitting) that producing the
 * rows themselves requires.
 *
 * Guarantees: for any `options`, `populationIdentifiers(options).userIds`
 * equals `generatePopulation(options).users.map(u => u.id)` in the same
 * order, because both are built from the same plannedUsers() plan. This is
 * what lets reset.ts know exactly what to delete without ever having
 * generated or stored a manifest of what seed.ts wrote.
 */
export function populationIdentifiers(options: PopulationOptions = {}): {
  userIds: string[];
  venueIds: string[];
  dishIds: string[];
} {
  const resolved = resolveOptions(options);
  const archetypes = resolveArchetypes(resolved.archetypeCount);
  const plan = plannedUsers(archetypes, resolved.usersPerArchetype);

  return {
    userIds: plan.map((p) => seedUuid(`user:${p.handle}`)),
    venueIds: Array.from({ length: resolved.venueCount }, (_, i) => seedUuid(`venue:${i}`)),
    dishIds: Array.from({ length: resolved.dishPoolSize }, (_, i) => seedUuid(`dish:${i}`)),
  };
}

/**
 * Generate a full synthetic demo population.
 *
 * Guarantees:
 *  - Deterministic: the same `options` always produce byte-identical output,
 *    including every id, because randomness is drawn from a seeded PRNG and
 *    ids are derived from stable keys rather than gen_random_uuid().
 *  - Every user's `fitted` theta comes from actually running Track A's
 *    fitTheta over that user's own generated duels, not from copying
 *    `trueTheta`, so what this produces is what a real prefs row would hold.
 *  - Every user has at least `duelsPerUser` duels, comfortably above
 *    CONSTANTS.MIN_DUELS_FOR_TWINS, and distinct, independent provenance
 *    (own invite root, unique fingerprint, creation time spaced by
 *    USER_SPACING_MS from every other seeded user).
 *  - Every record is reachable as seeded by SEED_PREFIX, gplaceId, or
 *    surface: 'demo'. See SEED_PREFIX's doc comment for the mapping.
 *
 * Does not verify that twins actually form: that is a property of Track A's
 * computeTwins applied to this output, checked in population.test.ts, not
 * something this function can assert about itself without importing the
 * twins module for no other reason.
 */
export function generatePopulation(options: PopulationOptions = {}): SeededPopulation {
  const resolved = resolveOptions(options);
  const archetypes = resolveArchetypes(resolved.archetypeCount);
  const rand = rng(resolved.seed);

  const venues = buildVenues(rand, resolved.venueCount);
  const dishes = buildDishPool(rand, resolved.dishPoolSize, venues, resolved.referenceTime);
  const dishById = new Map(dishes.map((d) => [d.id, d] as const));

  const plan = plannedUsers(archetypes, resolved.usersPerArchetype);
  const refMs = Date.parse(resolved.referenceTime);

  const users: SeedUser[] = [];
  const devices: SeedDevice[] = [];
  const duels: SeedDuel[] = [];

  plan.forEach((planned, globalIndex) => {
    const { archetype, handle } = planned;
    const userId = seedUuid(`user:${handle}`);
    const deviceId = seedUuid(`device:${handle}`);
    const fingerprint = `${SEED_PREFIX}fp_${handle}`;
    const createdAt = new Date(refMs - globalIndex * USER_SPACING_MS).toISOString();

    const trueTheta = archetype.centroid.map((v) => v + resolved.thetaNoiseSigma * gaussian(rand));

    const userDuels = generateDuelsForUser(
      userId, deviceId, dishes, trueTheta, resolved.duelsPerUser, rand, createdAt,
    );

    const observations = userDuels.map((d) => {
      const loserId = d.dishA === d.winner ? d.dishB : d.dishA;
      return {
        winnerPhi: dishById.get(d.winner)!.vector.phi,
        loserPhi: dishById.get(loserId)!.vector.phi,
      };
    });
    const fitted = fitTheta(observations);

    const [relMin, relMax] = resolved.reliabilityRange;
    const reliability = Number((relMin + rand() * (relMax - relMin)).toFixed(3));

    users.push({
      id: userId,
      handle,
      archetypeId: archetype.id,
      trueTheta,
      fitted,
      provenance: { inviterId: null, fingerprint, createdAt },
      reliability,
      seeded: true,
    });
    devices.push({ id: deviceId, userId, fingerprint, firstSeen: createdAt, seeded: true });
    duels.push(...userDuels);
  });

  return { archetypes: archetypes.slice(), venues, dishes, users, devices, duels };
}

export const __testing = { rng, gaussian, plannedUsers, USER_SPACING_MS };
