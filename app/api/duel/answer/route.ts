/**
 * POST /api/duel/answer. Track C.
 *
 * Records one duel and refits theta. This is the highest-frequency write in
 * the product and the only place a duel becomes a fact instead of a
 * suggestion, so validation here is stricter than most routes: dishA, dishB
 * and winner must all be dishes this corpus actually has, winner must be one
 * of the two, and the pair must be two distinct dishes.
 */

import { isThetaStable } from '@/core';
import { ApiError, jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { identityKey, rateLimitKey, resolveIdentity } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { parseJsonObject, requireEnum, requireString } from '@/lib/api/validate';
import { lookupDish } from '@/lib/store/corpus';
import { type DuelSurface, getOrCreateIdentity, recordDuel } from '@/lib/store/memory';
import { hydrateIdentity, persistDuel } from '@/lib/store/persist';

const SURFACES: readonly DuelSurface[] = ['feed', 'imessage', 'agent', 'demo'];

/** Dish ids in this corpus are short, url-safe tokens like "d17". */
const DISH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const body = await parseJsonObject(request);
    const identity = resolveIdentity(body);
    enforceRateLimit(rateLimitKey('duel/answer', request, identity), LIMITS.duelAnswer);

    const dishA = requireString(body, 'dishA', {
      pattern: DISH_ID_RE,
      patternHint: '"dishA" must be a dish id.',
    });
    const dishB = requireString(body, 'dishB', {
      pattern: DISH_ID_RE,
      patternHint: '"dishB" must be a dish id.',
    });
    const winner = requireString(body, 'winner', {
      pattern: DISH_ID_RE,
      patternHint: '"winner" must be a dish id.',
    });
    const surface = requireEnum(body, 'surface', SURFACES);

    if (dishA === dishB) {
      throw new ApiError('invalid_body', 'dishA and dishB must be different dishes.', 'dishB');
    }
    if (winner !== dishA && winner !== dishB) {
      throw new ApiError('invalid_body', 'winner must equal dishA or dishB.', 'winner');
    }
    if (!lookupDish(dishA) || !lookupDish(dishB)) {
      throw new ApiError('invalid_body', 'dishA and dishB must be known dishes.', 'dishA');
    }

    const stored = getOrCreateIdentity(identityKey(identity), identity.deviceId, identity.userId);
    // Replay anything this instance has never seen BEFORE recording, or a cold
    // instance would fit theta on one duel and report nComparisons of 1 to
    // somebody who has swiped twenty.
    await hydrateIdentity(stored);
    const updated = recordDuel(stored, dishA, dishB, winner, surface);

    // Durable, and awaited so a serverless function cannot be frozen before
    // the write lands. Best effort inside: a failure never fails the pick.
    await persistDuel(identity.deviceId, dishA, dishB, winner, surface);

    return jsonOk({
      userVector: {
        theta: updated.theta,
        nComparisons: updated.nComparisons,
        posteriorVar: updated.posteriorVar,
        updatedAt: updated.updatedAt,
      },
      thetaStable: isThetaStable(updated),
    });
  });
}
