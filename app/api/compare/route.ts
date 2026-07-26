/**
 * POST /api/compare. Track C.
 *
 * A ClientComparisonView between the requester and the creator of a shared
 * duel card. Comparison is anchored to a card on purpose: it is the only
 * pairing this route can produce, the two people who already share one duel
 * card, so there is no way to use this route as an open lookup of an
 * arbitrary stranger's profile. That would be a stranger-to-stranger channel
 * by another name (hard rule 4) even though nothing here routes a message.
 *
 * verdictText is written deterministically in this file, never by a model:
 * there is no EvidencePacket-shaped pipeline for a two-person comparison in
 * '@/core', and hard rule 2 is easiest to keep by never handing a model
 * anything to decide in the first place.
 *
 * HARD RULE 1 AND THE FROZEN ComparisonResult SHAPE, resolved
 * An earlier pass narrowed this response to counts only, on the argument that
 * agreementRate and hardestDivergence.aValue/bValue are numbers about people.
 * That reading was rejected on integration, for two reasons that both matter:
 *
 * 1. Rule 1 governs what is DISPLAYED. Track B's ComparisonView renders the
 *    rate as "agreed on 7 of 12" (a count, the explicitly allowed shape) and
 *    uses aValue/bValue only as coordinates to place two markers on an axis
 *    whose ends are labeled in words. No numeric score about a person ever
 *    reaches the screen. Carrying positioning data on the wire so the UI can
 *    draw language-labeled geometry is the sanctioned pattern, not a breach.
 *
 * 2. contracts/types.ts is frozen and is law. A route that unilaterally stops
 *    honoring a frozen field breaks the other two tracks at runtime, which is
 *    exactly the failure the freeze exists to prevent. Narrowing the contract
 *    is a group-chat decision for Track A, not a route-level veto.
 *
 * So this route returns ComparisonResult verbatim. The values are exposed only
 * within a card-anchored pairing (see above), never through any open lookup.
 */

import { AXES, AXIS_COUNT, AXIS_KEYS } from '@/contracts/axes';
import { CONSTANTS, type ComparisonResult, type Vec24 } from '@/contracts/types';
import { cosineSimilarity, predictPreference } from '@/core';
import { ApiError, jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { identityKey, rateLimitKey, resolveIdentity } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { parseJsonObject, requireString } from '@/lib/api/validate';
import { DISHES } from '@/lib/store/corpus';
import { getCard, getOrCreateIdentity, peekIdentity } from '@/lib/store/memory';

const CARD_ID_RE = /^[A-Za-z0-9]{3,32}$/;


export async function POST(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const body = await parseJsonObject(request);
    const identity = resolveIdentity(body);
    enforceRateLimit(rateLimitKey('compare', request, identity), LIMITS.compare);

    const cardId = requireString(body, 'cardId', {
      pattern: CARD_ID_RE,
      patternHint: '"cardId" must be a card id.',
    });

    const record = getCard(cardId);
    if (!record) {
      throw new ApiError('not_found', 'No card with that id.');
    }

    const self = getOrCreateIdentity(identityKey(identity), identity.deviceId, identity.userId);
    const other = peekIdentity(record.creatorKey);
    // A creator with no fitted theta yet (the card was made, never played)
    // still produces a defined comparison: zero vector, no evidence either way.
    const otherTheta: Vec24 = other?.theta ?? new Array(AXIS_COUNT).fill(0);

    return jsonOk({ comparison: buildComparison(self.theta, otherTheta) });
  });
}

function buildComparison(thetaA: Vec24, thetaB: Vec24): ComparisonResult {
  let idx = 0;
  let widest = -1;
  for (let i = 0; i < AXIS_COUNT; i++) {
    const d = Math.abs(thetaA[i] - thetaB[i]);
    if (d > widest) {
      widest = d;
      idx = i;
    }
  }

  // Agreement across the whole verified corpus rather than only the pairs
  // this specific card produced: a shared-card demo cannot guarantee the two
  // people played the same duels, and their independently fitted thetas are
  // comparable against any dish regardless of who has actually tried it.
  const reference = new Array(AXIS_COUNT).fill(0);
  let agree = 0;
  for (const d of DISHES) {
    const pa = predictPreference(thetaA, d.vector.phi, reference);
    const pb = predictPreference(thetaB, d.vector.phi, reference);
    if (pa >= 0.5 === (pb >= 0.5)) agree++;
  }
  const totalCount = DISHES.length;
  const agreementRate =
    totalCount > 0 ? Math.round((agree / totalCount) * 100) / 100 : 0;
  const areTwins = cosineSimilarity(thetaA, thetaB) >= CONSTANTS.TWIN_COSINE_TAU;
  const label = AXES[idx].label;

  return {
    agreementRate,
    hardestDivergence: {
      axis: AXIS_KEYS[idx],
      label,
      // Coordinates for the UI's divergence markers, drawn on an axis whose
      // ends are words. Rounded to 2dp: enough to place a marker, and not a
      // precision that invites reading them as scores.
      aValue: Math.round(thetaA[idx] * 100) / 100,
      bValue: Math.round(thetaB[idx] * 100) / 100,
    },
    areTwins,
    verdictText: describeComparison(agree, totalCount, areTwins, label),
  };
}

/** Flat, specific, no enthusiasm markers. Same voice rule as core/render.ts, hard rule 6. */
function describeComparison(
  agreedCount: number,
  totalCount: number,
  areTwins: boolean,
  divergenceLabel: string,
): string {
  const rate = totalCount > 0 ? agreedCount / totalCount : 0;
  if (areTwins) {
    return `You are taste twins, which is rarer than it sounds. The one real split between you is ${divergenceLabel}.`;
  }
  if (rate >= 0.7) {
    return `You are not taste twins, but you agree more than you split. The clearest difference is ${divergenceLabel}.`;
  }
  if (rate >= 0.45) {
    return `You are not taste twins. You split about as often as you agree, mostly over ${divergenceLabel}.`;
  }
  return `You are not taste twins. You disagree more than you agree, and it shows most on ${divergenceLabel}.`;
}
