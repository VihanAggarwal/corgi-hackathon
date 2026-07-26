/**
 * GET /api/card/[cardId]. Track C.
 *
 * The card payload for Track B's share view (app/c/[cardId]). No identity is
 * required to read a card: a card is meant to be opened by a phone that has
 * never seen this product before, which is the entire point of the channel.
 * Rate limiting therefore keys on address rather than a device id that does
 * not exist yet for a first-time visitor.
 */

import { ApiError, jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { rateLimitKey } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { getCard } from '@/lib/store/memory';

const CARD_ID_RE = /^[A-Za-z0-9]{3,32}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ cardId: string }> },
): Promise<Response> {
  return withApiHandler(async () => {
    enforceRateLimit(rateLimitKey('card/read', request, null), LIMITS.cardRead);

    const { cardId } = await params;
    if (!CARD_ID_RE.test(cardId)) {
      throw new ApiError('invalid_query', 'cardId is not a valid card id.', 'cardId');
    }

    const record = getCard(cardId);
    if (!record) {
      throw new ApiError('not_found', 'No card with that id.');
    }

    return jsonOk({
      card: record.card,
      // Null when the sender created the card before picking a side. There is
      // no display name to send alongside it: this product has no handle
      // concept behind a device-only identity, see the track report.
      senderPickedDishId: record.senderPickedDishId,
      createdAt: record.createdAt,
    });
  });
}
