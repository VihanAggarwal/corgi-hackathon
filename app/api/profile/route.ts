/**
 * GET /api/profile. Track C.
 *
 * UserVector + TwinStatus + PalateRegion for a device or a user. TwinStatus is
 * returned exactly as the contract types it: {enabled, twinCount, reason?}.
 * There is no fourth field. When enabled is false there is nothing in this
 * response shaped like a twin claim, because there is nothing else IN the
 * TwinStatus type to put one in: the honesty here is structural, not a
 * decision this route has to remember to make on every request.
 */

import { computeRegion, type RatedDish } from '@/core';
import { jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { identityKey, rateLimitKey, resolveIdentity } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { computeTwinsForIdentity } from '@/lib/api/twins';
import { queryObject } from '@/lib/api/validate';
import { lookupDish } from '@/lib/store/corpus';
import { getOrCreateIdentity } from '@/lib/store/memory';
import { hydrateIdentity } from '@/lib/store/persist';

export async function GET(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const query = queryObject(request);
    const identity = resolveIdentity(query);
    enforceRateLimit(rateLimitKey('profile', request, identity), LIMITS.profile);

    const stored = getOrCreateIdentity(identityKey(identity), identity.deviceId, identity.userId);
    // Cold serverless instances hold an empty Map; replay stored duels so a
    // calibrated person is not reported as brand new. See lib/store/persist.
    await hydrateIdentity(stored);

    const ratedDishes: RatedDish[] = [];
    for (const log of stored.logs) {
      const dish = lookupDish(log.dishId);
      if (dish) ratedDishes.push({ dishId: dish.id, phi: dish.vector.phi, rating: log.rating });
    }
    const region = computeRegion(ratedDishes);

    const twins = computeTwinsForIdentity(stored);

    return jsonOk({
      userVector: {
        theta: stored.theta,
        nComparisons: stored.nComparisons,
        posteriorVar: stored.posteriorVar,
        updatedAt: stored.updatedAt,
      },
      // TwinStatus, verbatim: enabled, twinCount, and reason only when disabled.
      // computeTwins builds this object itself, so nothing here can widen it.
      twinStatus: twins.status,
      region: {
        volume: region.volume,
        exploredAxes: region.exploredAxes,
        frontierAxes: region.frontierAxes,
        measuredAt: region.measuredAt,
      },
    });
  });
}
