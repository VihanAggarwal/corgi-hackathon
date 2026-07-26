/**
 * The in-memory store. Track C.
 *
 * WHY THIS EXISTS
 * There is no .env.local yet and there may not be one before judging. Every
 * route in this track still has to return real, coherent data: a duel history,
 * a fitted theta, population statistics a recommendation can be judged
 * against. This module is where that data lives when there is no Postgres to
 * put it in, a process-local Map rebuilt from nothing on every cold start.
 *
 * WHAT PRODUCTION NEEDS
 * Every shape here has a home in contracts/schema.sql already: StoredIdentity
 * is `prefs` plus `devices`/`users`, duelHistory is `duels` verbatim, and the
 * dish aggregates are a materialized view. The swap is mechanical because
 * every function below returns the same shape a Supabase query would, so the
 * route handlers that call them do not change.
 *
 * WHY A DUEL DOUBLES AS A RATING
 * contracts/schema.sql has a `logs` table (rating 1..5) that is a genuinely
 * different signal from a duel, and no route in this track's scope writes to
 * it, there is no /api/log endpoint in the spec. PalateRegion and the palate
 * portrait both need rated dishes to work from, and a duel is the only signal
 * this track's routes actually produce. So a duel win is treated as an
 * implicit positive log (rating 5, at REGION_CONSTANTS.POSITIVE_RATING_MIN)
 * and a loss as a mild negative (rating 2). This is a real modeling choice,
 * not a placeholder, and it is named here so nobody downstream mistakes it for
 * a rating a person actually typed in. See docs gap noted in the track report.
 *
 * CONCURRENCY
 * A single Map mutated per request is fine for a hackathon process handling
 * one request at a time per identity. It is not safe against two concurrent
 * requests for the SAME identity racing a read-modify-write of theta, which
 * production needs a real transaction for, the same caveat as the rate
 * limiter in lib/api/rate-limit.ts.
 */

import type { DuelCard, PalateRegion, Vec24 } from '@/contracts/types';
import { fitTheta, populationPrior, type FitObservation } from '@/core';
import { DISH_BY_ID, venueName } from '@/components/mock/fixtures';
import { maskedIndicesForDish } from './corpus';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface StoredIdentity {
  /** identityKey() from lib/api/identity: "user:<id>" or "device:<id>". */
  readonly key: string;
  deviceId: string | null;
  userId: string | null;
  readonly createdAt: string;
  /** Provenance input for computeTwins. A device id is the only fingerprint we have. */
  fingerprint: string | null;
  seenDishIds: Set<string>;
  observations: FitObservation[];
  logs: Array<{ dishId: string; dishName: string; rating: number }>;
  theta: Vec24;
  nComparisons: number;
  posteriorVar: number;
  axisVariance: number[];
  updatedAt: string;
  /** The region measured as of the last portrait, so the next one can report movement. */
  lastPortraitRegion: PalateRegion | null;
}

const identities = new Map<string, StoredIdentity>();

/**
 * Read or create the identity row for a key.
 *
 * Guarantees: the same key always returns the same object reference, so a
 * mutation by recordDuel is visible to the next call without a second lookup.
 * A userId arriving on a call for an identity that started as device-only is
 * attached rather than ignored, since that is what "a person eventually makes
 * an account" looks like for a key that was minted before they had one.
 */
export function getOrCreateIdentity(
  key: string,
  deviceId: string | null,
  userId: string | null,
): StoredIdentity {
  const existing = identities.get(key);
  if (existing) {
    if (userId && !existing.userId) existing.userId = userId;
    if (deviceId && !existing.fingerprint) existing.fingerprint = deviceId;
    return existing;
  }
  const now = new Date().toISOString();
  // fitTheta([]) rather than a guessed constant: it is the same n=0 case
  // recordDuel will produce on the first real observation, so a freshly
  // created identity and a freshly fitted one agree on what "no data" means.
  const initial = fitTheta([]);
  const created: StoredIdentity = {
    key,
    deviceId,
    userId,
    createdAt: now,
    fingerprint: deviceId,
    seenDishIds: new Set(),
    observations: [],
    logs: [],
    theta: initial.theta,
    nComparisons: initial.nComparisons,
    posteriorVar: initial.posteriorVar,
    axisVariance: initial.axisVariance,
    updatedAt: now,
    lastPortraitRegion: null,
  };
  identities.set(key, created);
  return created;
}

/** Look up an identity without creating one. Used where "unknown" is a valid answer. */
export function peekIdentity(key: string): StoredIdentity | undefined {
  return identities.get(key);
}

/** Every identity except the one given, for twin candidate pools. */
export function listOtherIdentities(excludeKey: string): StoredIdentity[] {
  return [...identities.values()].filter((i) => i.key !== excludeKey);
}

/** Record the region measured at the most recent portrait. */
export function setLastPortraitRegion(key: string, region: PalateRegion): void {
  const identity = identities.get(key);
  if (identity) identity.lastPortraitRegion = region;
}

// ---------------------------------------------------------------------------
// Duels
// ---------------------------------------------------------------------------

export type DuelSurface = 'feed' | 'imessage' | 'agent' | 'demo';

interface DuelRecord {
  identityKey: string;
  dishA: string;
  dishB: string;
  winner: string;
  surface: DuelSurface;
  at: string;
}

const duelHistory: DuelRecord[] = [];

/**
 * Record a duel outcome and refit theta.
 *
 * Guarantees:
 *  - the duel is appended to the population history regardless of whether
 *    either dish is verified, because population appearance and win rate
 *    (duel-select's population gate, lift's population baseline) are honest
 *    facts about what got shown and picked, not about calibration quality;
 *  - a fit observation, and therefore any effect on theta, is added ONLY when
 *    both dishes are verified (hard rule 7);
 *  - the returned identity is the same object passed in, mutated in place, so
 *    callers holding a prior reference see the update.
 */
export function recordDuel(
  identity: StoredIdentity,
  dishA: string,
  dishB: string,
  winner: string,
  surface: DuelSurface,
): StoredIdentity {
  const now = new Date().toISOString();
  duelHistory.push({ identityKey: identity.key, dishA, dishB, winner, surface, at: now });

  identity.seenDishIds.add(dishA);
  identity.seenDishIds.add(dishB);

  const loser = winner === dishA ? dishB : dishA;
  const winDish = DISH_BY_ID.get(winner);
  const loseDish = DISH_BY_ID.get(loser);

  if (winDish?.verified && loseDish?.verified) {
    const masked = new Set([...maskedIndicesForDish(winDish), ...maskedIndicesForDish(loseDish)]);
    identity.observations.push({
      winnerPhi: winDish.vector.phi,
      loserPhi: loseDish.vector.phi,
      maskedIdx: [...masked],
    });
  }

  // Implicit logs, see the file header. Only real corpus dishes contribute:
  // an id that slipped past validation upstream must not become a phantom log.
  if (winDish) identity.logs.push({ dishId: winDish.id, dishName: winDish.name, rating: 5 });
  if (loseDish) identity.logs.push({ dishId: loseDish.id, dishName: loseDish.name, rating: 2 });

  const priorThetas = listOtherIdentities(identity.key)
    .filter((i) => i.nComparisons > 0)
    .map((i) => i.theta);
  const prior = populationPrior(priorThetas);

  const fit = fitTheta(identity.observations, { prior });
  identity.theta = fit.theta;
  identity.nComparisons = fit.nComparisons;
  identity.posteriorVar = fit.posteriorVar;
  identity.axisVariance = fit.axisVariance;
  identity.updatedAt = fit.updatedAt;

  return identity;
}

// ---------------------------------------------------------------------------
// Population aggregates
//
// Scanned from duelHistory on every call rather than maintained incrementally.
// A hackathon corpus produces at most a few thousand duels in a process
// lifetime, so an O(n) scan is invisible; a real deployment replaces these
// with a materialized aggregate, not with cleverness here.
// ---------------------------------------------------------------------------

/** How often a dish has appeared in any duel, and how often it won. */
export function dishAppearanceStats(dishId: string): { appearances: number; wins: number } {
  let appearances = 0;
  let wins = 0;
  for (const d of duelHistory) {
    if (d.dishA !== dishId && d.dishB !== dishId) continue;
    appearances++;
    if (d.winner === dishId) wins++;
  }
  return { appearances, wins };
}

/**
 * Distinct people who have had this dish in a duel, and how many of them won
 * with it. Feeds lift's PopulationObservations: one row per person, matching
 * the guarantee lift.ts documents on TwinObservations.n.
 */
export function populationObservationsFor(dishId: string): { n: number; positive: number } {
  const total = new Set<string>();
  const positive = new Set<string>();
  for (const d of duelHistory) {
    if (d.dishA !== dishId && d.dishB !== dishId) continue;
    total.add(d.identityKey);
    if (d.winner === dishId) positive.add(d.identityKey);
  }
  return { n: total.size, positive: positive.size };
}

/** The same count, restricted to a given set of twin identity keys. */
export function twinObservationsFor(
  dishId: string,
  twinKeys: ReadonlySet<string>,
): { n: number; positive: number } {
  const total = new Set<string>();
  const positive = new Set<string>();
  for (const d of duelHistory) {
    if (!twinKeys.has(d.identityKey)) continue;
    if (d.dishA !== dishId && d.dishB !== dishId) continue;
    total.add(d.identityKey);
    if (d.winner === dishId) positive.add(d.identityKey);
  }
  return { n: total.size, positive: positive.size };
}

/** Win counts per dish at a venue, standing in for order counts (no POS data exists). */
export function venueOrderCounts(venueId: string): Array<{ dishName: string; orders: number }> {
  const counts = new Map<string, number>();
  for (const d of duelHistory) {
    const w = DISH_BY_ID.get(d.winner);
    if (!w || w.venueId !== venueId) continue;
    counts.set(w.name, (counts.get(w.name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([dishName, orders]) => ({ dishName, orders }));
}

// ---------------------------------------------------------------------------
// Share cards
// ---------------------------------------------------------------------------

interface CardRecord {
  card: DuelCard;
  creatorKey: string;
  senderPickedDishId: string | null;
  createdAt: string;
}

const cards = new Map<string, CardRecord>();

/** Five base36 characters, matching the shape of the seeded demo card ids. */
function randomCardId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/**
 * Create a share card for a dish pair.
 *
 * Guarantees: the returned cardId is unique among cards created this process
 * lifetime, and shareUrl matches the route app/c/[cardId]/page.tsx already
 * serves. Throws only if the caller passes an unknown dish id, which route
 * validation must catch before this is ever called.
 */
export function createCard(
  dishAId: string,
  dishBId: string,
  creatorKey: string,
  senderPickedDishId: string | null,
): DuelCard {
  const a = DISH_BY_ID.get(dishAId);
  const b = DISH_BY_ID.get(dishBId);
  if (!a || !b) throw new Error('createCard requires two known dish ids');

  let cardId = randomCardId();
  while (cards.has(cardId)) cardId = randomCardId();

  const card: DuelCard = {
    cardId,
    a: { dishId: a.id, name: a.name, venueName: venueName(a.venueId), imageUrl: a.imageUrl },
    b: { dishId: b.id, name: b.name, venueName: venueName(b.venueId), imageUrl: b.imageUrl },
    shareUrl: `/c/${cardId}`,
  };
  cards.set(cardId, { card, creatorKey, senderPickedDishId, createdAt: new Date().toISOString() });
  return card;
}

export function getCard(cardId: string): CardRecord | undefined {
  return cards.get(cardId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Drop every identity, duel, and card. Exists so tests do not leak into each other. */
export function resetStoreForTests(): void {
  identities.clear();
  duelHistory.length = 0;
  cards.clear();
}
