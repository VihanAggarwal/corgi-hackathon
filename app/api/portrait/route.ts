/**
 * GET /api/portrait. Track C.
 *
 * A palate portrait for a device or a user. Generation itself, and the
 * anti-horoscope verification, are entirely Track A's (core/portrait.ts).
 * This route's job is only to assemble PortraitInput from the store: the
 * region before and after, the implicit rating log, and the population prior.
 *
 * NO CREDENTIALS, NO PROBLEM
 * generatePalatePortrait degrades to a deterministic draft generator with no
 * ANTHROPIC_API_KEY (core/portrait.ts's own dryRunEnabled), so this route
 * needs no branch of its own for the no-key case.
 */

import { computeRegion, generatePalatePortrait, populationPrior, type RatedDish } from '@/core';
import { ApiError, jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { identityKey, rateLimitKey, resolveIdentity } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { queryObject } from '@/lib/api/validate';
import { lookupDish } from '@/lib/store/corpus';
import { getOrCreateIdentity, listOtherIdentities, setLastPortraitRegion } from '@/lib/store/memory';
import { hydrateIdentity } from '@/lib/store/persist';

export async function GET(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const query = queryObject(request);
    const identity = resolveIdentity(query);
    enforceRateLimit(rateLimitKey('portrait', request, identity), LIMITS.portrait);

    const stored = getOrCreateIdentity(identityKey(identity), identity.deviceId, identity.userId);
    // Cold serverless instances hold an empty Map; replay stored duels so a
    // calibrated person is not reported as brand new. See lib/store/persist.
    await hydrateIdentity(stored);

    const ratedDishes: RatedDish[] = [];
    for (const log of stored.logs) {
      const dish = lookupDish(log.dishId);
      if (dish) ratedDishes.push({ dishId: dish.id, phi: dish.vector.phi, rating: log.rating });
    }
    const regionAfter = computeRegion(ratedDishes);
    // The region as of the previous portrait, or the honest cold-start region
    // (no positives, volume 0) for a first read. Passing the same region twice
    // is legal per core/portrait.ts and is exactly what a first portrait is.
    const regionBefore = stored.lastPortraitRegion ?? computeRegion([]);

    const priorThetas = listOtherIdentities(stored.key)
      .filter((i) => i.nComparisons > 0)
      .map((i) => i.theta);

    let portrait;
    try {
      portrait = await generatePalatePortrait({
        userId: stored.key,
        user: {
          theta: stored.theta,
          nComparisons: stored.nComparisons,
          posteriorVar: stored.posteriorVar,
          updatedAt: stored.updatedAt,
        },
        logs: stored.logs.map((l) => ({ dishName: l.dishName, rating: l.rating })),
        regionBefore,
        regionAfter,
        populationPrior: populationPrior(priorThetas),
      });
    } catch {
      // generatePalatePortrait throws only after every retry fails its own
      // anti-horoscope check. That is a real failure to surface, but the
      // reason (which sentence failed which check) is written for a developer
      // reading logs, not for a client: a portrait that only compliments is
      // worse than no portrait, and the error text can quote packet content.
      throw new ApiError('unavailable', 'A portrait could not be produced right now. Try again shortly.');
    }

    setLastPortraitRegion(stored.key, regionAfter);
    return jsonOk({ portrait });
  });
}
