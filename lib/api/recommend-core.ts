/**
 * Corpus recommendation, shared by the HTTP route and the iMessage agent.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * This logic used to live inline in app/api/recommend/route.ts, which meant the
 * only way to get a recommendation was an HTTP request. The agent therefore had
 * no way to answer "where should i eat" and fell back to asking for a menu
 * photo, which reads as broken: the corpus recommendation needs no menu at all.
 *
 * Extracting it is the fix, and it must stay extracted. Two implementations of
 * this pipeline would be two places for the constraint filter or the twin gate
 * to be forgotten, and both of those are hard rules rather than preferences.
 *
 * ORDER IS LOAD BEARING, top to bottom:
 *   1. constraint filter (hard rule 3, before ranking and before any model)
 *   2. frontier rank against the palate region boundary
 *   3. lift gate per dish, deciding twin channel versus content channel
 *   4. evidence packet, which is the privacy boundary
 *   5. render, which only ever speaks what the packet contains
 */

import {
  buildEvidencePacket,
  computeRegion,
  evaluateLift,
  expansionForPacket,
  rankFrontier,
  renderRecommendation,
  twinSupportForPacket,
  type FrontierCandidate,
  type RatedDish,
} from '@/core';
import type { EvidencePacket, RenderedRecommendation } from '@/contracts/types';
import { constraintFilteredDishes } from '@/lib/api/constraint-scope';
import { computeTwinsForIdentity } from '@/lib/api/twins';
import { identityKey, type Identity } from '@/lib/api/identity';
import { withFallback } from '@/lib/resilience/call';
import { DISHES, lookupDish, venueHood, venueName } from '@/lib/store/corpus';
import {
  getOrCreateIdentity,
  populationObservationsFor,
  twinObservationsFor,
  venueOrderCounts,
  type StoredIdentity,
} from '@/lib/store/memory';

export interface RecommendOptions {
  count?: number;
}

/**
 * Rendered recommendations for one identity, drawn from the corpus.
 *
 * Returns fewer than `count`, possibly zero, when candidates fail their own
 * packet scan or the renderer is unavailable. Callers must handle an empty
 * array rather than assume a pick exists: an honest nothing beats a fabricated
 * something, which would be a model deciding rather than rendering.
 */
export async function recommendForIdentity(
  identity: Identity,
  stored: StoredIdentity,
  options: RecommendOptions = {},
): Promise<RenderedRecommendation[]> {
  const count = options.count ?? 3;

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

  return recommendations;
}

/** Convenience for callers that only have a device id, such as the agent. */
export async function recommendForDevice(
  deviceId: string,
  options: RecommendOptions = {},
): Promise<RenderedRecommendation[]> {
  const identity: Identity = { deviceId, userId: null };
  const stored = getOrCreateIdentity(identityKey(identity), deviceId, null);
  return recommendForIdentity(identity, stored, options);
}
