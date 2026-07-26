/**
 * THE SWAP MODULE.
 *
 * Every surface in /app and /components reads its data from here and nowhere
 * else. Today each function returns a fixture. At the integration pass, each
 * body becomes a fetch of one of Track C's routes and no component changes.
 *
 * If integration ever requires editing a component, this abstraction was wrong.
 */

import type {
  ComparisonResult,
  DuelCard,
  PalatePortrait,
  PalateRegion,
  RenderedRecommendation,
  TwinStatus,
} from "@/contracts/types";
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
  TWIN_STATUS_ON,
  venueHood,
  venueName,
  type DemoEvent,
} from "@/components/mock/fixtures";

/**
 * True while the functions below return fixtures. A surface that shows
 * fabricated history reads this instead of hardcoding a badge, so the label
 * disappears with the swap rather than needing a component edit.
 */
export const IS_SEEDED = true;

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

/**
 * A block of duels, delivered up front so the feed never waits on the network
 * between picks. Track A selects for information gain; the swap keeps the same
 * shape and the same "hand me several" contract, because a spinner between
 * duels is the one thing that would kill this surface.
 */
export async function getDuelBlock(
  count = DUEL_PAIRS.length,
  seed = 0,
): Promise<DuelPairView[]> {
  const out: DuelPairView[] = [];
  for (let i = 0; i < count; i++) {
    const [a, b] = DUEL_PAIRS[(i + seed) % DUEL_PAIRS.length];
    // Alternate side so the answer is never "always the left one".
    const flip = (i + seed) % 3 === 1;
    out.push({
      pairId: `p_${seed}_${i}`,
      a: toView(flip ? b : a),
      b: toView(flip ? a : b),
    });
  }
  return out;
}

/** Fire-and-forget. A duel must never block the next duel on a round trip. */
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
}

export async function getShareCard(
  cardId: string,
): Promise<ShareCardView | null> {
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
  return PORTRAIT;
}

export async function getRegionStates(): Promise<{
  before: PalateRegion;
  after: PalateRegion;
}> {
  return { before: REGION_BEFORE, after: REGION_AFTER };
}

export async function getComparison(cardId: string): Promise<ComparisonResult> {
  // Disagreement is the normal outcome and the designed-for one. One seeded
  // card returns agreement so the rarer branch is demonstrable.
  return cardId === "p4w9r" ? COMPARISON_AGREE : COMPARISON_DISAGREE;
}

/**
 * When this returns enabled: false, no surface may render the word "twin".
 * Not greyed out, not "coming soon". Absent. Hard rule 5.
 */
export async function getTwinStatus(): Promise<TwinStatus> {
  return process.env.NEXT_PUBLIC_TWINS_DISABLED === "1"
    ? TWIN_STATUS_OFF
    : TWIN_STATUS_ON;
}

export async function getRecommendations(): Promise<RenderedRecommendation[]> {
  const twins = await getTwinStatus();
  return twins.enabled
    ? RECOMMENDATIONS
    : RECOMMENDATIONS.filter((r) => r.sourceChannel !== "twin");
}

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

export async function getDemoEvents(): Promise<DemoEvent[]> {
  return DEMO_EVENTS;
}

export async function getDemoCardId(): Promise<string> {
  return SEED_CARDS[0].cardId;
}

export function dishCount(): number {
  return DISHES.length;
}

export type { DemoEvent };
