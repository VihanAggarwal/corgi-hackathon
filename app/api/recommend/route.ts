/**
 * POST /api/recommend. Track C.
 *
 * RenderedRecommendation[] for a device or a user. The only route that talks
 * to a model, and every hard rule about generation converges here:
 *
 *   rule 2  the packet is built by buildEvidencePacket and rendered by
 *           renderRecommendation, both from '@/core'. This file decides
 *           WHICH dish and gathers evidence about it; it never writes a
 *           sentence.
 *   rule 3  constraintFilteredDishes runs BEFORE ranking or packet building,
 *           so a filtered dish can never re-enter through a later step.
 *   rule 5  twinSupportForPacket (the '@/core' composed gate) decides whether
 *           twin language is even possible, before a packet is built.
 */

import {
  buildEvidencePacket,
  evaluateLift,
  expansionForPacket,
  type FrontierCandidate,
  rankFrontier,
  type RatedDish,
  computeRegion,
  renderRecommendation,
  twinSupportForPacket,
} from '@/core';
import type { EvidencePacket, RenderedRecommendation } from '@/contracts/types';
import { constraintFilteredDishes } from '@/lib/api/constraint-scope';
import { jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { identityKey, rateLimitKey, resolveIdentity } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { boundedInt, parseJsonObject } from '@/lib/api/validate';
import { computeTwinsForIdentity } from '@/lib/api/twins';
import { withFallback } from '@/lib/resilience/call';
import { DISHES, lookupDish, venueHood, venueName } from '@/lib/store/corpus';
import {
  getOrCreateIdentity,
  populationObservationsFor,
  twinObservationsFor,
  venueOrderCounts,
} from '@/lib/store/memory';

export async function POST(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const body = await parseJsonObject(request);
    const identity = resolveIdentity(body);
    enforceRateLimit(rateLimitKey('recommend', request, identity), LIMITS.recommend);

    const count = boundedInt(body, 'count', { min: 1, max: 5, fallback: 3 });
    const stored = getOrCreateIdentity(identityKey(identity), identity.deviceId, identity.userId);

    const ratedDishes: RatedDish[] = [];
    for (const log of stored.logs) {
      const dish = lookupDish(log.dishId);
      if (dish) ratedDishes.push({ dishId: dish.id, phi: dish.vector.phi, rating: log.rating });
    }
    const region = computeRegion(ratedDishes);

    // A recommendation for something already duelled is not a discovery.
    const unseen = DISHES.filter((d) => !stored.seenDishIds.has(d.id));

    // Hard rule 3. The filter runs on the whole candidate list before ranking,
    // before a packet is built, and before any model call.
    const { dishes: candidates, appliedCount } = await constraintFilteredDishes(identity, unseen);

    const frontierCandidates: FrontierCandidate[] = candidates.map((d) => ({
      dishId: d.id,
      phi: d.vector.phi,
    }));
    const ranked = rankFrontier(frontierCandidates, region, stored.theta);

    const twinComputation = computeTwinsForIdentity(stored);
    const twinKeys = new Set(twinComputation.links.map((l) => l.twinUserId));

    const recommendations: RenderedRecommendation[] = [];

    for (const score of ranked.slice(0, count)) {
      const dish = lookupDish(score.dishId);
      if (!dish) continue;

      const population = populationObservationsFor(dish.id);
      const twin = twinObservationsFor(dish.id, twinKeys);
      const orders = venueOrderCounts(dish.venueId);
      const liftDecision = evaluateLift({ twin, population, venueOrders: orders });

      // The composed gate from '@/core', not the half-gate in twins.ts or
      // lift.ts. See core/index.ts: neither raw function is exported, this is
      // the only way to build twinSupport, on purpose.
      const twinSupport = twinSupportForPacket(twinComputation, liftDecision);

      let packet: EvidencePacket;
      try {
        packet = buildEvidencePacket({
          user: {
            theta: stored.theta,
            nComparisons: stored.nComparisons,
            posteriorVar: stored.posteriorVar,
          },
          dish: {
            name: dish.name,
            venueName: venueName(dish.venueId),
            neighborhood: venueHood(dish.venueId),
            priceCents: dish.priceCents,
            phi: dish.vector.phi,
            confidence: dish.vector.confidence,
            maskedAxes: dish.vector.maskedAxes,
          },
          twin: twinSupport
            ? { n: twinSupport.n, lift: twinSupport.lift, clusterDescriptor: twinSupport.clusterDescriptor }
            : undefined,
          populationBaseline: liftDecision.evidence.populationBaseline,
          expansion: expansionForPacket(score),
          sourceChannel: twinSupport ? 'twin' : 'content',
          constraintsAppliedCount: appliedCount,
        });
      } catch {
        // A packet that fails its own privacy or grounding scan must never
        // reach a renderer. Skip this dish and keep whatever else ranked,
        // rather than fail the whole request over one candidate.
        continue;
      }

      const rendered = await withFallback<RenderedRecommendation | null>(
        () => renderRecommendation(packet),
        () => null,
        { dependency: 'render', timeoutMs: 8000, attempts: 1, budgetMs: 8000 },
      );
      if (rendered.value) recommendations.push(rendered.value);
    }

    return jsonOk({ recommendations });
  });
}
