/**
 * POST /api/duel/next. Track C.
 *
 * The next duel pair for a device or a user. Device-only is the primary path:
 * the whole growth loop is a person with no account playing duels from a
 * message thread, so this route never requires userId.
 */

import { type DuelCandidate, selectDuels } from '@/core';
import { constraintFilteredDishes } from '@/lib/api/constraint-scope';
import { jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { identityKey, rateLimitKey, resolveIdentity } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { boundedInt, parseJsonObject } from '@/lib/api/validate';
import { DISHES, type DishView, maskedIndicesForDish, toDishView } from '@/lib/store/corpus';
import { dishAppearanceStats, getOrCreateIdentity } from '@/lib/store/memory';

export async function POST(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const body = await parseJsonObject(request);
    const identity = resolveIdentity(body);
    enforceRateLimit(rateLimitKey('duel/next', request, identity), LIMITS.duelNext);

    const count = boundedInt(body, 'count', { min: 1, max: 20, fallback: 10 });
    const stored = getOrCreateIdentity(identityKey(identity), identity.deviceId, identity.userId);

    // Hard rule 3 in spirit as well as letter: a constraint should stop a dish
    // from being offered at all, not merely stop it from being narrated.
    const { dishes } = await constraintFilteredDishes(identity, DISHES);

    const pool: DuelCandidate[] = dishes.map((d) => {
      const stats = dishAppearanceStats(d.id);
      return {
        dishId: d.id,
        phi: d.vector.phi,
        maskedIdx: maskedIndicesForDish(d),
        populationWinRate: stats.appearances > 0 ? stats.wins / stats.appearances : undefined,
        appearances: stats.appearances,
        verified: d.verified,
        venueId: d.venueId,
      };
    });

    const pairs = selectDuels(pool, {
      theta: stored.theta,
      seenDishIds: stored.seenDishIds,
      count,
    });

    interface PairView {
      pairId: string;
      a: DishView;
      b: DishView;
    }

    const base = Date.now().toString(36);
    const out: PairView[] = [];
    pairs.forEach((p, i) => {
      const a = toDishView(p.a.dishId);
      const b = toDishView(p.b.dishId);
      // Both ids came from the same corpus this pool was built from, so a miss
      // here would mean the corpus and the store disagree. Skip rather than
      // throw: one bad pair should not cost the whole feed.
      if (a && b) out.push({ pairId: `p_${base}_${i}`, a, b });
    });

    return jsonOk({ pairs: out });
  });
}
