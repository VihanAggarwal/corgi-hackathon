/**
 * POST /api/recommend. Track C.
 *
 * A thin transport shell. The pipeline itself lives in
 * lib/api/recommend-core.ts, and every hard rule about generation is enforced
 * there:
 *
 *   rule 2  the packet is built by buildEvidencePacket and rendered by
 *           renderRecommendation, both from '@/core'. Nothing writes a
 *           sentence outside the renderer.
 *   rule 3  constraintFilteredDishes runs BEFORE ranking or packet building,
 *           so a filtered dish can never re-enter through a later step.
 *   rule 5  twinSupportForPacket (the '@/core' composed gate) decides whether
 *           twin language is even possible, before a packet is built.
 *
 * The logic moved out of this file because the iMessage agent needs the
 * identical path: someone texting "where should i eat" must get the same
 * filter, the same twin gate, and the same packet a browser gets. Two copies
 * would be two places for one of those rules to be forgotten.
 */

import { jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { identityKey, rateLimitKey, resolveIdentity } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { recommendForIdentity } from '@/lib/api/recommend-core';
import { boundedInt, parseJsonObject } from '@/lib/api/validate';
import { getOrCreateIdentity } from '@/lib/store/memory';

export async function POST(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const body = await parseJsonObject(request);
    const identity = resolveIdentity(body);
    enforceRateLimit(rateLimitKey('recommend', request, identity), LIMITS.recommend);

    const count = boundedInt(body, 'count', { min: 1, max: 5, fallback: 3 });
    const stored = getOrCreateIdentity(identityKey(identity), identity.deviceId, identity.userId);

    const area = typeof body.area === 'string' ? body.area : null;
    const excludeRaw = Array.isArray(body.exclude) ? body.exclude : [];
    const exclude = new Set(excludeRaw.filter((v): v is string => typeof v === 'string'));

    const recommendations = await recommendForIdentity(identity, stored, {
      count,
      area,
      exclude,
    });
    return jsonOk({ recommendations });
  });
}
