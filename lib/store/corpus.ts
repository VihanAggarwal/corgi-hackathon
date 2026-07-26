/**
 * The dish corpus, as the API layer sees it. Track C.
 *
 * READ-ONLY IMPORT OF TRACK B'S FIXTURES
 * contracts/schema.sql's `dishes` and `venues` tables have no data in them:
 * there is no database configured yet. components/mock/fixtures.ts already
 * carries a small, hand-built corpus typed against the frozen contract, and
 * CLAUDE.md's ownership table marks /components read-only for this track. Two
 * corpora that are both supposed to describe the same twenty dishes and
 * inevitably drift apart is a worse failure than the cross-track read, so the
 * routes in app/api/** see exactly the dishes the demo pages render.
 *
 * When Supabase lands, this file is the one seam that changes: every function
 * below keeps its signature and starts querying `dishes` and `venues` instead.
 */

import { AXIS_KEYS } from '@/contracts/axes';
import { CONSTANTS, type Dish } from '@/contracts/types';
import { DISHES, DISH_BY_ID, VENUES, venueHood, venueName } from '@/components/mock/fixtures';

export { DISHES, DISH_BY_ID, VENUES, venueHood, venueName };

/** A dish by id, or undefined. Never throws: an unknown id is a caller's bug to handle. */
export function lookupDish(dishId: string): Dish | undefined {
  return DISH_BY_ID.get(dishId);
}

/**
 * Axis indices this dish's vector may not be spoken about or fit against.
 *
 * Unions the extractor's own maskedAxes with everything below CONF_THRESHOLD,
 * the same rule core/packet.ts applies. Computed here rather than trusted from
 * the fixture, because a future corpus source (a real extraction pipeline)
 * will only carry the confidence vector, not a pre-unioned mask.
 */
export function maskedIndicesForDish(dish: Dish): number[] {
  const masked = new Set<number>();
  for (const key of dish.vector.maskedAxes) {
    const i = AXIS_KEYS.indexOf(key);
    if (i >= 0) masked.add(i);
  }
  dish.vector.confidence.forEach((c, i) => {
    if (!(c >= CONSTANTS.CONF_THRESHOLD)) masked.add(i);
  });
  return [...masked].sort((a, b) => a - b);
}

/**
 * The shape a duel screen or a share card needs. Deliberately identical, field
 * for field, to components/data's DishView: when Track B swaps its fixture
 * calls for a fetch of this route, the response needs no reshaping on their
 * side. If this drifts from that type, the swap stops being free.
 */
export interface DishView {
  dishId: string;
  name: string;
  venueName: string;
  neighborhood: string;
  description: string | null;
  priceCents: number | null;
  imageUrl: string | null;
}

/** A dish as a view, or null for an unknown id. */
export function toDishView(dishId: string): DishView | null {
  const d = DISH_BY_ID.get(dishId);
  if (!d) return null;
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
