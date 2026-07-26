/**
 * THE SWAP MODULE.
 *
 * Every surface in /app and /components reads its data from here and nowhere
 * else. Bodies now call Track C's routes under app/api/**, falling back to
 * Track B's fixtures whenever a call fails or is slow. No component changed.
 *
 * WHY FIXTURES ARE STILL IMPORTED
 * Two reasons, not one. First, resilience: every exported function here must
 * degrade to a fixture on any fetch failure, so a flaky route never becomes an
 * error screen or a spinner (see the track brief). Second, the dish corpus
 * itself: there is no live menu source yet (no Google Places, no database), so
 * DISHES and DISH_BY_ID from components/mock/fixtures ARE the corpus, the same
 * one lib/store/corpus.ts imports on Track C's side. Looking a dish up locally
 * here is not a fixture fallback, it is reading the one source of truth both
 * tracks already share.
 *
 * ENVIRONMENT: SERVER VS BROWSER
 * This file has no "use client" directive, so it is bundled into both server
 * components (app/duel/page.tsx, app/portrait/page.tsx, ...) and client
 * components (DuelFeed, CardScreen) that import it. `typeof window` is the
 * only safe way to branch on that, and it is used twice: to build an absolute
 * URL for server-side fetch (relative URLs have no base outside a browser),
 * and to read the same device id components/lib/device.ts already persisted
 * to localStorage, without importing that "use client" module here.
 */

import type {
  ComparisonResult,
  DuelCard,
  PalatePortrait,
  PalateRegion,
  RenderedRecommendation,
  TwinStatus,
} from "@/contracts/types";
import { computeRegion } from "@/core";
import {
  CARD_SENDERS,
  COMPARISON_AGREE,
  COMPARISON_DISAGREE,
  DEMO_EVENTS,
  DISHES,
  DISH_BY_ID,
  DUEL_PAIRS,
  PORTRAIT,
  RECOMMENDATIONS,
  REGION_AFTER,
  REGION_BEFORE,
  SEED_CARDS,
  TWIN_STATUS_OFF,
  venueHood,
  venueName,
  type DemoEvent,
} from "@/components/mock/fixtures";

/**
 * False now that every surface below attempts a live route first. Left as a
 * named export, and false rather than deleted, because app/portrait/page.tsx
 * reads it synchronously to decide whether to paint the "seeded demo data"
 * badge, and a Server Component cannot await a per-request flag through a
 * plain import. The one blind spot this accepts: if a route call fails and a
 * function below quietly serves a fixture, the badge does not reappear for
 * that one response. That trade is deliberate, the alternative is editing a
 * component this pass is not supposed to touch.
 */
export const IS_SEEDED = false;

// ---------------------------------------------------------------------------
// view types: the shape a surface actually needs, derived from the contract
// ---------------------------------------------------------------------------

export interface DishView {
  dishId: string;
  name: string;
  venueName: string;
  neighborhood: string;
  description: string | null;
  priceCents: number | null;
  imageUrl: string | null;
}

export interface DuelPairView {
  pairId: string;
  a: DishView;
  b: DishView;
}

export interface ShareCardView {
  card: DuelCard;
  /** First name only. There is no profile to open and no way to reply. */
  senderFirstName: string;
  /** What the sender picked, revealed only after the recipient has picked. */
  senderPickedDishId: string;
}

// ---------------------------------------------------------------------------
// fetch plumbing
// ---------------------------------------------------------------------------

/**
 * How long a route gets before this module gives up and serves a fixture.
 * Short on purpose: the one thing worse than fixture data is a visible wait
 * for real data, see the track brief's "a fixture is always better than a
 * spinner".
 */
const FETCH_TIMEOUT_MS = 2500;

/** Absolute base URL for a server-side fetch. Empty (relative) in the browser. */
function apiOrigin(): string {
  if (typeof window !== "undefined") return "";
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  // Vercel sets this at build and runtime with no protocol prefix.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * The device id for this call.
 *
 * In the browser this reads the id components/lib/device.ts already created
 * and persisted to localStorage (that module runs first, on the first pick or
 * the first render of a client component, so by the time a comparison or a
 * twin status is requested the key exists). During server rendering there is
 * no browser and no request-scoped device concept threaded through these
 * frozen function signatures, so calls fall back to the literal "server",
 * which matches DEVICE_ID_RE and is the same fallback string
 * components/lib/device.ts itself returns when window is undefined. See the
 * track report for what this costs: every visitor's pre-hydration page load
 * shares one anonymous bucket server-side until their own client code takes
 * over with submitDuel.
 */
function currentDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem("tt.device");
    if (existing) return existing;
  } catch {
    /* localStorage unavailable: fall through to the shared anonymous id */
  }
  return "server";
}

/**
 * Fetch JSON from one of this track's routes, or null.
 *
 * Guarantees: never throws. A timeout, a network error, a non-2xx status, and
 * an unparsable body are all the same outcome to a caller, "no live data this
 * time", because every exported function below has exactly one fallback for
 * all of them: serve the fixture.
 */
async function callApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiOrigin()}${path}`, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function postJson<T>(path: string, body: unknown): Promise<T | null> {
  return callApi<T>(path, { method: "POST", body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------

/** Local corpus lookup. Real data: see the file header on why this is not a fixture path. */
function toView(dishId: string): DishView {
  const d = DISH_BY_ID.get(dishId)!;
  return {
    dishId: d.id,
    name: d.name,
    venueName: venueName(d.venueId),
    neighborhood: venueHood(d.venueId),
    description: d.description,
    priceCents: d.priceCents,
    imageUrl: d.imageUrl,
  };
}

/** components/mock/fixtures' hand-built block, unchanged: the fallback path. */
function fixtureDuelBlock(count: number, seed: number): DuelPairView[] {
  const out: DuelPairView[] = [];
  for (let i = 0; i < count; i++) {
    const [a, b] = DUEL_PAIRS[(i + seed) % DUEL_PAIRS.length];
    const flip = (i + seed) % 3 === 1;
    out.push({
      pairId: `p_${seed}_${i}`,
      a: toView(flip ? b : a),
      b: toView(flip ? a : b),
    });
  }
  return out;
}

/**
 * A block of duels, delivered up front so the feed never waits on the network
 * between picks. /api/duel/next selects for real information gain against
 * this device's history; on any failure the hand-picked fixture pairs stand
 * in, keeping the same "hand me several" shape either way.
 */
export async function getDuelBlock(
  count = DUEL_PAIRS.length,
  seed = 0,
): Promise<DuelPairView[]> {
  const live = await postJson<{ pairs: DuelPairView[] }>("/api/duel/next", {
    deviceId: currentDeviceId(),
    count,
  });
  if (live?.pairs && live.pairs.length > 0) return live.pairs;
  return fixtureDuelBlock(count, seed);
}

/**
 * Fire-and-forget. A duel must never block the next duel on a round trip, so
 * this neither awaits the caller's attention nor rethrows: the pick is already
 * recorded locally (components/lib/device.ts's appendPick) before this runs,
 * and a lost write here costs population statistics, not the user's own feed.
 */
export async function submitDuel(input: {
  deviceId: string;
  dishA: string;
  dishB: string;
  winner: string;
  surface: "feed" | "imessage" | "agent" | "demo";
}): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[duel]", input.surface, input.winner);
  }
  try {
    await postJson("/api/duel/answer", input);
  } catch {
    /* fire-and-forget: a failed write here must never surface anywhere */
  }
}

export async function getShareCard(
  cardId: string,
): Promise<ShareCardView | null> {
  const live = await callApi<{ card: DuelCard; senderPickedDishId: string | null }>(
    `/api/card/${encodeURIComponent(cardId)}`,
  );
  if (live) {
    return {
      card: live.card,
      // The route deliberately carries no display name: a device-only
      // identity has no handle to attach one to. "Someone" is the honest
      // answer, not a placeholder, and matches the fixture's own fallback.
      senderFirstName: CARD_SENDERS[live.card.cardId] ?? "Someone",
      // ShareCardView's contract is a non-null dishId (Track B's frozen view
      // type); the route's is nullable, "sender made the card before
      // picking". Default to side A rather than widen the exported type.
      senderPickedDishId: live.senderPickedDishId ?? live.card.a.dishId,
    };
  }
  const card = SEED_CARDS.find((c) => c.cardId === cardId) ?? SEED_CARDS[0];
  if (!card) return null;
  return {
    card,
    senderFirstName: CARD_SENDERS[card.cardId] ?? "Someone",
    senderPickedDishId: card.a.dishId,
  };
}

/** The duels a recipient of a shared card plays, starting with the card pair. */
export async function getDuelBlockForCard(
  cardId: string,
): Promise<DuelPairView[]> {
  const share = await getShareCard(cardId);
  const rest = await getDuelBlock(11, 3);
  if (!share) return rest;
  return [
    {
      pairId: `card_${cardId}`,
      a: toView(share.card.a.dishId),
      b: toView(share.card.b.dishId),
    },
    ...rest,
  ];
}

export async function getPortrait(): Promise<PalatePortrait> {
  const live = await callApi<{ portrait: PalatePortrait }>(
    `/api/portrait?deviceId=${encodeURIComponent(currentDeviceId())}`,
  );
  return live?.portrait ?? PORTRAIT;
}

export async function getRegionStates(): Promise<{
  before: PalateRegion;
  after: PalateRegion;
}> {
  const live = await callApi<{ region: PalateRegion }>(
    `/api/profile?deviceId=${encodeURIComponent(currentDeviceId())}`,
  );
  if (live?.region) {
    // /api/portrait computes a regionBefore internally (this device's region
    // as of its last portrait read) but its response only carries {portrait},
    // and no route exposes that snapshot back to a client. See the track
    // report. The honest "before" available here is the model's own cold
    // start, not an invented number: the empty region is what "before this
    // device rated anything" means by definition.
    return { before: computeRegion([]), after: live.region };
  }
  return { before: REGION_BEFORE, after: REGION_AFTER };
}

export async function getComparison(cardId: string): Promise<ComparisonResult> {
  const live = await postJson<{ comparison: ComparisonResult }>("/api/compare", {
    deviceId: currentDeviceId(),
    cardId,
  });
  if (live?.comparison) return live.comparison;
  // Disagreement is the normal outcome and the designed-for one. One seeded
  // card returns agreement so the rarer branch is demonstrable even offline.
  return cardId === "p4w9r" ? COMPARISON_AGREE : COMPARISON_DISAGREE;
}

/**
 * When this returns enabled: false, no surface may render the word "twin".
 * Not greyed out, not "coming soon". Absent. Hard rule 5.
 *
 * There is no dedicated twin-status route; /api/profile carries it, gated the
 * same way core/index.ts's twinSupportForPacket gates a recommendation. On any
 * failure this returns TWIN_STATUS_OFF rather than the old fixture's always-on
 * default: faking a twin because the network hiccuped is exactly what hard
 * rule 5 forbids, and "off" is always a truthful answer, "on" might not be.
 */
export async function getTwinStatus(): Promise<TwinStatus> {
  if (process.env.NEXT_PUBLIC_TWINS_DISABLED === "1") return TWIN_STATUS_OFF;
  const live = await callApi<{ twinStatus: TwinStatus }>(
    `/api/profile?deviceId=${encodeURIComponent(currentDeviceId())}`,
  );
  return live?.twinStatus ?? TWIN_STATUS_OFF;
}

export async function getRecommendations(): Promise<RenderedRecommendation[]> {
  const live = await postJson<{ recommendations: RenderedRecommendation[] }>(
    "/api/recommend",
    { deviceId: currentDeviceId() },
  );
  if (live?.recommendations) return live.recommendations;
  const twins = await getTwinStatus();
  return twins.enabled
    ? RECOMMENDATIONS
    : RECOMMENDATIONS.filter((r) => r.sourceChannel !== "twin");
}

/**
 * A recommendation by packetId, or the first available one.
 *
 * /api/recommend has no lookup-by-id counterpart: every call generates a fresh
 * batch with fresh packetIds, nothing persists a rendering so it can be
 * refetched later by the id a share link carries. See the track report; this
 * is a real gap, not an oversight in this file. The fallback below is
 * therefore the same "find, or take the first" the fixture always used,
 * sourced from whatever getRecommendations() returns live or otherwise.
 */
export async function getRecommendation(
  packetId: string,
): Promise<RenderedRecommendation | null> {
  const all = await getRecommendations();
  return all.find((r) => r.packetId === packetId) ?? all[0] ?? null;
}

export async function getDishView(
  dishId: string | null,
): Promise<DishView | null> {
  if (!dishId || !DISH_BY_ID.has(dishId)) return null;
  return toView(dishId);
}

/**
 * No activity-feed route exists under app/api/**: the demo presenter view was
 * always meant to show seeded history plus real picks arriving live from the
 * same browser session (see components/demo/DemoFeed.tsx's own comment on this
 * becoming "a poll of Track C's activity route"). That route was never built
 * against this spec, so this stays fixture-only. Reported in the track report.
 */
export async function getDemoEvents(): Promise<DemoEvent[]> {
  return DEMO_EVENTS;
}

/**
 * Memoized per server process, matching the same process-lifetime model
 * lib/store/memory.ts already uses for identities and cards. Creating a fresh
 * card on every render of the demo page would change the QR code on every
 * refresh, which is a worse demo than a card that stays stable and simply
 * accumulates real duel history as phones scan it.
 */
let demoCardPromise: Promise<string> | null = null;

/** The device id backing the presenter's own demo card, distinct from any real visitor. */
const DEMO_DEVICE_ID = "demo-presenter";

async function createDemoCard(): Promise<string> {
  const [dishA, dishB] = DUEL_PAIRS[0];
  const created = await postJson<DuelCard>("/api/card/create", {
    deviceId: DEMO_DEVICE_ID,
    dishA,
    dishB,
  });
  return created?.cardId ?? SEED_CARDS[0].cardId;
}

export async function getDemoCardId(): Promise<string> {
  if (!demoCardPromise) demoCardPromise = createDemoCard();
  return demoCardPromise;
}

/** Real corpus size. Not a fixture count: see the file header. */
export function dishCount(): number {
  return DISHES.length;
}

export type { DemoEvent };
