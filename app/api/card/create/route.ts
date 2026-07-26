/**
 * POST /api/card/create. Track C.
 *
 * A DuelCard with a short shareUrl, the object a message thread turns into a
 * rich card. shareUrl points at app/c/[cardId], Track B's existing share page.
 */

import { ApiError, jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { identityKey, rateLimitKey, resolveIdentity } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { optionalString, parseJsonObject, requireString } from '@/lib/api/validate';
import { lookupDish } from '@/lib/store/corpus';
import { createCard, getOrCreateIdentity } from '@/lib/store/memory';

const DISH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const body = await parseJsonObject(request);
    const identity = resolveIdentity(body);
    enforceRateLimit(rateLimitKey('card/create', request, identity), LIMITS.cardCreate);

    const dishA = requireString(body, 'dishA', {
      pattern: DISH_ID_RE,
      patternHint: '"dishA" must be a dish id.',
    });
    const dishB = requireString(body, 'dishB', {
      pattern: DISH_ID_RE,
      patternHint: '"dishB" must be a dish id.',
    });
    // Optional: a card can be created before its creator has picked a side,
    // e.g. to send a pair to a friend and let them go first.
    const winner = optionalString(body, 'winner', {
      pattern: DISH_ID_RE,
      patternHint: '"winner" must equal dishA or dishB.',
    });

    if (dishA === dishB) {
      throw new ApiError('invalid_body', 'dishA and dishB must be different dishes.', 'dishB');
    }
    if (!lookupDish(dishA) || !lookupDish(dishB)) {
      throw new ApiError('invalid_body', 'dishA and dishB must be known dishes.', 'dishA');
    }
    if (winner && winner !== dishA && winner !== dishB) {
      throw new ApiError('invalid_body', 'winner must equal dishA or dishB.', 'winner');
    }

    const stored = getOrCreateIdentity(identityKey(identity), identity.deviceId, identity.userId);
    const card = createCard(dishA, dishB, stored.key, winner);

    return jsonOk(card, 201);
  });
}
