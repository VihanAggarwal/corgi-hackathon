/**
 * E1, the team dinner. Track C.
 *
 * The whole feature is one sentence: a dinner where nobody has to announce
 * their celiac diagnosis at the table. The organizer picks a place, everyone
 * can eat, and the organizer is told "4 constraints applied" and nothing else.
 *
 * THE ORDER OF OPERATIONS IS THE PRODUCT
 *
 *   consent gate            org_members.consented_at, no exceptions
 *          v
 *   candidate dishes        geo, budget, party size
 *          v
 *   SET INTERSECTION        applyOrgConstraints, values in, one integer out
 *          v
 *   ranking                 group theta dot dish phi
 *          v
 *   EvidencePacket          count only, no values, no owners
 *          v
 *   renderer                the first and only model call
 *
 * Nothing can reorder those steps by accident, because the unfiltered candidate
 * list never leaves this function: applyOrgConstraints is what produces the
 * list that everything downstream is written against.
 *
 * WHAT NEVER HAPPENS HERE
 * Constraints never enter theta. Two people are not taste twins because they
 * are both kosher, and the group vector is built from duel-fitted preferences
 * with no constraint input at any point. Constraints never enter a prompt: the
 * packet carries `constraintsAppliedCount` and core/render.ts deliberately
 * withholds even that from the brief. Nothing in this file logs.
 *
 * NO TWIN CHANNEL ON THIS PATH
 * Packets built here carry no twinSupport. A team dinner is a group decision
 * and the k floor is about a specific person's supporters, so there is no
 * honest twin claim to make about six colleagues. Hard rule 5 is satisfied by
 * the field being absent rather than by a gate returning false.
 */

import { AXIS_COUNT } from '../../contracts/axes';
import type {
  Conf24,
  EnterpriseDinnerRequest,
  EnterpriseDinnerResult,
  EvidencePacket,
  Vec24,
} from '../../contracts/types';
import { buildEvidencePacket, renderRecommendation, type RenderOptions } from '../../core';
import type { ConstraintCandidate } from '../db';
import { applyOrgConstraints, type HrisProvider, type HrisSubject } from '../../integrations/hris/provider';
import {
  consentedSubjects,
  defaultOrgMemberSource,
  type OrgMemberSource,
} from './members';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A dish as the dinner planner needs it.
 *
 * Venue fields are denormalized onto the dish on purpose. The unit of filtering
 * is a dish, because a constraint removes dishes and not restaurants, and
 * carrying the venue alongside avoids a second lookup between the filter and
 * the ranking. `lat` and `lng` are the venue's.
 */
export interface DinnerDish extends ConstraintCandidate {
  id: string;
  name: string;
  description?: string | null;
  tags?: readonly string[] | null;
  venueId: string;
  venueName: string;
  neighborhood: string;
  lat: number;
  lng: number;
  priceCents: number | null;
  phi: Vec24;
  confidence?: Conf24;
}

export interface DinnerDishSource {
  /**
   * Dishes worth considering for this request. May over-return: the planner
   * re-applies the radius and the budget, so a source that ignores either
   * cannot widen the candidate set.
   */
  candidatesForDinner(request: EnterpriseDinnerRequest): Promise<readonly DinnerDish[]>;
}

export interface GroupTasteSource {
  /**
   * The group's preference vector, built from duel-fitted thetas only.
   *
   * Constraints are not an input and must never become one. Returning a zero
   * vector is the honest answer for a group we have not fitted yet: it produces
   * no driving axes in the packet rather than three invented ones.
   */
  groupTheta(userIds: readonly string[]): Promise<Vec24>;
}

export interface DinnerDeps {
  dishes: DinnerDishSource;
  members?: OrgMemberSource;
  /** Defaults to the registry's choice: Agent Handler when keyed, else self-declared. */
  provider?: HrisProvider;
  taste?: GroupTasteSource;
  /** orgs.merge_account_token for this org. Opaque, server-only, never logged. */
  accountToken?: string | null;
  /**
   * Passed through to Track A's renderer. The one seam a test can use to stand
   * in for the model, which is how "no model call happens on the constraint
   * path" is proved rather than asserted.
   */
  renderOptions?: RenderOptions;
  maxVenues?: number;
}

/** Thrown when the request cannot produce an honest plan. */
export class DinnerRequestError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid enterprise dinner request: ${problems.join('; ')}`);
    this.name = 'DinnerRequestError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Five venues is a shortlist. Twenty is a search result, and nobody reads it. */
const DEFAULT_MAX_VENUES = 5;

/** A table of eight does not need eight separate suggestions to start ordering. */
const MAX_DISHES_PER_VENUE = 6;

/** Sanity ceiling on the request. A party of four hundred is a typo. */
const MAX_PARTY_SIZE = 200;

/** Sanity ceiling on the search radius, in meters. */
const MAX_RADIUS_M = 50_000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Check a request before anything is fetched.
 *
 * Guarantees a list of every problem rather than the first one, because an
 * organizer fixing a form one field per round trip gives up. Returns an empty
 * array when the request is usable.
 */
export function validateDinnerRequest(request: EnterpriseDinnerRequest): string[] {
  const problems: string[] = [];

  if (typeof request.orgId !== 'string' || request.orgId.trim().length === 0) {
    problems.push('orgId is required');
  }
  if (!Array.isArray(request.attendeeUserIds) || request.attendeeUserIds.length === 0) {
    problems.push('attendeeUserIds must be a non-empty array');
  } else if (!request.attendeeUserIds.every((id) => typeof id === 'string' && id.length > 0)) {
    problems.push('attendeeUserIds must be non-empty strings');
  }
  if (!Number.isInteger(request.partySize) || request.partySize < 1 || request.partySize > MAX_PARTY_SIZE) {
    problems.push(`partySize must be an integer between 1 and ${MAX_PARTY_SIZE}`);
  }
  if (!isFiniteNumber(request.lat) || request.lat < -90 || request.lat > 90) {
    problems.push('lat must be between -90 and 90');
  }
  if (!isFiniteNumber(request.lng) || request.lng < -180 || request.lng > 180) {
    problems.push('lng must be between -180 and 180');
  }
  if (!isFiniteNumber(request.radiusM) || request.radiusM <= 0 || request.radiusM > MAX_RADIUS_M) {
    problems.push(`radiusM must be between 1 and ${MAX_RADIUS_M}`);
  }
  if (request.maxPerHeadCents != null) {
    if (!Number.isInteger(request.maxPerHeadCents) || request.maxPerHeadCents <= 0) {
      problems.push('maxPerHeadCents must be a positive integer or null');
    }
  }
  // Validated rather than ignored. A window nobody can parse is a policy field
  // silently doing nothing, which is the failure mode of every unused input.
  if (typeof request.windowStart !== 'string' || Number.isNaN(Date.parse(request.windowStart))) {
    problems.push('windowStart must be an ISO 8601 timestamp');
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in meters. Haversine, which is exact enough at city scale. */
export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Non-constraint prefilters
// ---------------------------------------------------------------------------

/**
 * Radius and budget. Deliberately separate from the constraint filter.
 *
 * These are ordinary business rules and they are allowed to say why they
 * removed something. Constraints are not, which is why they never share a code
 * path with this: a filter that handled both would eventually grow one
 * explanation field and leak through it.
 *
 * A dish with no price is dropped when a budget exists. A policy cap is a hard
 * number, and an unpriced dish cannot be shown to satisfy one.
 */
export function prefilterDishes(
  request: EnterpriseDinnerRequest,
  dishes: readonly DinnerDish[],
): DinnerDish[] {
  const cap = request.maxPerHeadCents;
  return dishes.filter((d) => {
    if (!isFiniteNumber(d.lat) || !isFiniteNumber(d.lng)) return false;
    if (metersBetween(request.lat, request.lng, d.lat, d.lng) > request.radiusM) return false;
    if (cap != null) {
      if (d.priceCents == null) return false;
      if (d.priceCents > cap) return false;
    }
    if (!Array.isArray(d.phi) || d.phi.length !== AXIS_COUNT) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function dot(a: Vec24, b: Vec24): number {
  let sum = 0;
  for (let i = 0; i < AXIS_COUNT; i++) sum += a[i] * b[i];
  return sum;
}

interface VenueGroup {
  venueId: string;
  dishes: DinnerDish[];
  score: number;
}

/**
 * Group surviving dishes by venue and order both levels by group fit.
 *
 * A venue scores as its best dish rather than its mean, because the group is
 * going to one restaurant and will order the good thing, and averaging punishes
 * a place with a long menu. Ties keep the source order, so the result is stable
 * across runs with the same input.
 */
export function rankVenues(dishes: readonly DinnerDish[], theta: Vec24): VenueGroup[] {
  const byVenue = new Map<string, VenueGroup>();
  const order: string[] = [];

  for (const dish of dishes) {
    let group = byVenue.get(dish.venueId);
    if (!group) {
      group = { venueId: dish.venueId, dishes: [], score: -Infinity };
      byVenue.set(dish.venueId, group);
      order.push(dish.venueId);
    }
    const score = dot(theta, dish.phi);
    group.dishes.push(dish);
    if (score > group.score) group.score = score;
  }

  const groups = order.map((id) => byVenue.get(id)!);
  for (const group of groups) {
    const scored = group.dishes.map((d, i) => ({ d, i, s: dot(theta, d.phi) }));
    scored.sort((x, y) => (y.s - x.s) || (x.i - y.i));
    group.dishes = scored.map((x) => x.d);
  }
  groups.sort((a, b) => b.score - a.score);
  return groups;
}

// ---------------------------------------------------------------------------
// Result sealing
// ---------------------------------------------------------------------------

const RESULT_KEYS: ReadonlySet<string> = new Set(['candidates', 'constraintsAppliedCount']);
const CANDIDATE_KEYS: ReadonlySet<string> = new Set(['venueId', 'dishIds', 'reasonText']);

/**
 * Prove the response shape before it can be serialized.
 *
 * The contract already says what EnterpriseDinnerResult contains, but a type
 * stops at the module boundary and a route handler spreading an extra field
 * into the body is one keystroke. This throws rather than deleting, because a
 * planner that quietly repaired a leak would hide the bug that produced it.
 */
export function sealDinnerResult(result: EnterpriseDinnerResult): EnterpriseDinnerResult {
  for (const key of Object.keys(result)) {
    if (!RESULT_KEYS.has(key)) {
      throw new Error(`Dinner result carries a forbidden key "${key}".`);
    }
  }
  for (const candidate of result.candidates) {
    for (const key of Object.keys(candidate)) {
      if (!CANDIDATE_KEYS.has(key)) {
        throw new Error(`Dinner candidate carries a forbidden key "${key}".`);
      }
    }
    Object.freeze(candidate);
  }
  Object.freeze(result.candidates);
  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

function zeroTheta(): Vec24 {
  return new Array<number>(AXIS_COUNT).fill(0);
}

async function resolveTheta(
  taste: GroupTasteSource | undefined,
  subjects: readonly HrisSubject[],
): Promise<Vec24> {
  if (!taste) return zeroTheta();
  const theta = await taste.groupTheta(subjects.map((s) => s.userId));
  // A malformed vector from a source is not something to pad and hope about:
  // a short theta silently scores every dish the same. Fall back to zeros,
  // which produces a packet with no driving axes and therefore no claim.
  if (!Array.isArray(theta) || theta.length !== AXIS_COUNT || !theta.every(isFiniteNumber)) {
    return zeroTheta();
  }
  return theta;
}

/**
 * Plan a team dinner.
 *
 * Guarantees:
 *  - Only attendees with a non-null org_members.consented_at for this org are
 *    considered, and an attendee who is not a member of the org is excluded.
 *    There is no override, including for the demo.
 *  - Constraints are applied as a set intersection over the candidate dishes
 *    before any model call. With no surviving candidates, no model call is made
 *    at all.
 *  - No constraint value, kind, or owner is reachable from the return value.
 *    The only thing that leaves is `constraintsAppliedCount`, an integer.
 *  - Constraints are never an input to the group preference vector, and never
 *    appear in a prompt: the packet carries the count, and Track A's renderer
 *    withholds even that from the brief it sends.
 *  - Every reasonText was produced by Track A's renderer from an
 *    EvidencePacket, and has passed that renderer's validation. A candidate
 *    whose text cannot be validated is dropped rather than returned unchecked.
 *  - The returned object has exactly two keys and is frozen.
 *
 * Throws DinnerRequestError on an unusable request, and rethrows a provider
 * failure rather than falling back to a thinner constraint source, because
 * applying fewer constraints than an org has is how somebody gets served the
 * thing they are allergic to.
 */
export async function planTeamDinner(
  request: EnterpriseDinnerRequest,
  deps: DinnerDeps,
): Promise<EnterpriseDinnerResult> {
  const problems = validateDinnerRequest(request);
  if (problems.length > 0) throw new DinnerRequestError(problems);

  // 1. Consent gate. Everything after this point works with subjects, and a
  //    subject cannot exist without a consent timestamp.
  const members = deps.members ?? defaultOrgMemberSource();
  const memberships = await members.membershipsForOrg(request.orgId, request.attendeeUserIds);
  const subjects = consentedSubjects(memberships, request.attendeeUserIds);

  if (subjects.length === 0) {
    // Nobody consented, so there is no dinner to plan and nothing to count.
    return sealDinnerResult({ candidates: [], constraintsAppliedCount: 0 });
  }

  // 2. Candidates, then the ordinary business filters.
  const fetched = await deps.dishes.candidatesForDinner(request);
  const prefiltered = prefilterDishes(request, fetched);

  // 3. THE SET INTERSECTION. Rows are fetched, applied and discarded inside
  //    this call, so no line below here can hold a constraint value.
  const filtered = await applyOrgConstraints<DinnerDish>(
    { orgId: request.orgId, subjects, accountToken: deps.accountToken ?? null },
    prefiltered,
    deps.provider,
  );
  const appliedCount = filtered.appliedCount;

  if (filtered.candidates.length === 0) {
    // Honest empty result. The organizer still learns how many constraints were
    // applied, which is the difference between "nothing nearby" and "nothing
    // nearby that works for this group".
    return sealDinnerResult({ candidates: [], constraintsAppliedCount: appliedCount });
  }

  // 4. Ranking. Preference only. No constraint has touched this vector.
  const theta = await resolveTheta(deps.taste, subjects);
  const venues = rankVenues(filtered.candidates, theta);
  const maxVenues = deps.maxVenues ?? DEFAULT_MAX_VENUES;
  const shortlist = venues.slice(0, Math.max(1, maxVenues));
  const perVenue = Math.max(1, Math.min(request.partySize, MAX_DISHES_PER_VENUE));

  // 5. Packet, then render. The first model call in the whole function.
  const candidates: EnterpriseDinnerResult['candidates'] = [];
  for (const venue of shortlist) {
    const dishes = venue.dishes.slice(0, perVenue);
    const lead = dishes[0];

    let packet: EvidencePacket;
    try {
      packet = buildEvidencePacket({
        user: { theta },
        dish: {
          name: lead.name,
          venueName: lead.venueName,
          neighborhood: lead.neighborhood,
          priceCents: lead.priceCents,
          phi: lead.phi,
          ...(lead.confidence ? { confidence: lead.confidence } : {}),
        },
        caveats: [],
        // Not 'twin'. A team dinner has no twin claim to make, and the packet
        // builder would downgrade the channel anyway with no twinSupport.
        sourceChannel: 'content',
        // The count, and only the count. The values are already gone.
        constraintsAppliedCount: appliedCount,
      });
    } catch {
      // A packet we cannot build honestly is a venue we do not recommend.
      continue;
    }

    try {
      const rendered = await renderRecommendation(packet, deps.renderOptions);
      candidates.push({
        venueId: venue.venueId,
        dishIds: dishes.map((d) => d.id),
        reasonText: rendered.text,
      });
    } catch {
      // Validation refused the text. Dropping the venue is the right trade:
      // a missing candidate is a worse shortlist, a rule-breaking sentence is
      // the reason nobody believes the next hundred.
      continue;
    }
  }

  return sealDinnerResult({ candidates, constraintsAppliedCount: appliedCount });
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * A dish source backed by a fixed list.
 *
 * Guarantees: no network, no database, no credentials. This is what the tests
 * and the seeded demo run against.
 */
export function inMemoryDishSource(dishes: readonly DinnerDish[]): DinnerDishSource {
  const snapshot = dishes.map((d) => ({ ...d }));
  return {
    async candidatesForDinner() {
      return snapshot;
    },
  };
}

/** A group taste source backed by a fixed vector. */
export function fixedGroupTaste(theta: Vec24): GroupTasteSource {
  const snapshot = [...theta];
  return {
    async groupTheta() {
      return snapshot;
    },
  };
}
