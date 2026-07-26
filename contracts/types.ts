/**
 * FROZEN CONTRACT. All three tracks import from here.
 *
 * Rule: nobody edits this file without posting in the group chat first.
 * If you need a new field, add it as OPTIONAL and announce it. Never rename,
 * never change a type, never delete. Breaking this file breaks two other people.
 */

import type { AxisKey } from './axes';

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

/** Length 24, ordered by AXIS_KEYS. */
export type Vec24 = number[];

/** Per-axis confidence 0..1 from LLM extraction. Length 24. */
export type Conf24 = number[];

export interface DishVector {
  phi: Vec24;
  confidence: Conf24;
  /** Axes below CONF_THRESHOLD are masked and must not be used or spoken. */
  maskedAxes: AxisKey[];
}

export interface UserVector {
  theta: Vec24;
  nComparisons: number;
  /** Mean posterior variance. Below THETA_STABLE_VAR the profile is usable. */
  posteriorVar: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Venue {
  id: string;
  gplaceId: string | null;
  name: string;
  lat: number;
  lng: number;
  priceBand: 1 | 2 | 3 | 4;
  neighborhood: string;
  noiseLevel: number | null;
}

export interface Dish {
  id: string;
  venueId: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  vector: DishVector;
  /** true only for the hand-verified diagnostic pool. Calibration uses these ONLY. */
  verified: boolean;
  imageUrl: string | null;
  lastExtractedAt: string;
}

export interface Duel {
  id: string;
  deviceId: string;
  userId: string | null;
  dishA: string;
  dishB: string;
  winner: string;
  /** where the duel was played, for analytics */
  surface: 'feed' | 'imessage' | 'agent' | 'demo';
  createdAt: string;
}

export interface DishLog {
  id: string;
  userId: string;
  dishId: string;
  /** 1..5 */
  rating: number;
  note: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Twins
// ---------------------------------------------------------------------------

export interface TwinLink {
  userId: string;
  twinUserId: string;
  cosine: number;
  /** out-of-sample hit rate of the twin. INTERNAL ONLY. Never render. */
  reliability: number;
  weight: number; // cosine * reliability
}

export interface TwinStatus {
  /** false until the user clears thresholds. When false, the UI must say nothing about twins. */
  enabled: boolean;
  twinCount: number;
  reason?: 'need_more_duels' | 'population_too_small';
}

// ---------------------------------------------------------------------------
// Palate region / expansion
// ---------------------------------------------------------------------------

export interface PalateRegion {
  /** log-volume of the positively-rated region in 24-space */
  volume: number;
  /** axes where the user has explored beyond one sd from their centroid */
  exploredAxes: AxisKey[];
  /** axes with no positive rating yet: the frontier */
  frontierAxes: AxisKey[];
  measuredAt: string;
}

// ---------------------------------------------------------------------------
// THE EVIDENCE PACKET
// ---------------------------------------------------------------------------
// This is the ONLY thing the LLM renderer ever sees. It contains no user
// identities, no constraint values, no reliability scores, no raw records.
// Any sentence in the rendered output that is not grounded in a field here
// is a BUG, not a style issue.
// ---------------------------------------------------------------------------

export interface EvidencePacket {
  /** Only the axes that actually drove this recommendation. Max 3. */
  userAxes: Array<{
    axis: AxisKey;
    label: string;
    value: number;
    percentile: number;
  }>;

  dish: {
    name: string;
    venueName: string;
    neighborhood: string;
    priceCents: number | null;
    phiConfidence: 'high' | 'medium' | 'low';
  };

  /** Absent entirely when the twin channel did not fire. */
  twinSupport?: {
    n: number;
    /** P(positive|twins) - P(positive|population). Must exceed LIFT_DELTA. */
    lift: number;
    kFloorMet: boolean;
    /** Human-readable description of what defines this cluster, e.g.
     *  "people who, like you, will not accept sweetness in savory food" */
    clusterDescriptor: string;
  };

  /** What the room actually orders here. Enables the divergence sentence. */
  populationBaseline?: {
    topDishName: string;
    topDishShare: number;
  };

  /** MANDATORY in output when non-empty. */
  caveats: Array<{
    source: 'twin_note' | 'extraction' | 'venue_data';
    n: number;
    claim: string;
  }>;

  expansion?: {
    outsideRegion: boolean;
    axis: AxisKey;
    distance: 'adjacent' | 'far';
  };

  sourceChannel: 'twin' | 'content' | 'agent_vision';
  confidence: 'high' | 'medium' | 'low';

  /** Count only. NEVER the values, NEVER the types, NEVER whose. */
  constraintsAppliedCount: number;
}

export interface RenderedRecommendation {
  packetId: string;
  text: string;
  dishId: string | null;
  sourceChannel: EvidencePacket['sourceChannel'];
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export interface DuelCard {
  cardId: string;
  a: { dishId: string; name: string; venueName: string; imageUrl: string | null };
  b: { dishId: string; name: string; venueName: string; imageUrl: string | null };
  /** short URL rendered as a rich card in a message thread */
  shareUrl: string;
}

export interface ComparisonResult {
  agreementRate: number;
  /** the axis where the two people diverge most */
  hardestDivergence: { axis: AxisKey; label: string; aValue: number; bValue: number };
  areTwins: boolean;
  /** the honest line, generated. Usually "you are not twins". */
  verdictText: string;
}

export interface PalatePortrait {
  userId: string;
  body: string;
  /** enforced: the portrait must contain at least one unflattering true line */
  containsUnflattering: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Enterprise (Merge). Nothing here ever reaches the consumer ranking path.
// ---------------------------------------------------------------------------

export interface EnterpriseDinnerRequest {
  orgId: string;
  attendeeUserIds: string[];
  partySize: number;
  lat: number;
  lng: number;
  radiusM: number;
  /** derived from policy docs, already resolved to a number */
  maxPerHeadCents: number | null;
  windowStart: string;
}

export interface EnterpriseDinnerResult {
  candidates: Array<{ venueId: string; dishIds: string[]; reasonText: string }>;
  /** COUNT ONLY. Never the values. Never whose. */
  constraintsAppliedCount: number;
}

// ---------------------------------------------------------------------------
// Tunable constants. Track A owns these values; B and C read them.
// ---------------------------------------------------------------------------

export const CONSTANTS = {
  CONF_THRESHOLD: 0.6,
  THETA_STABLE_VAR: 0.35,
  MIN_DUELS_FOR_THETA: 12,
  MIN_DUELS_FOR_TWINS: 25,
  TWIN_COSINE_TAU: 0.72,
  K_FLOOR: 5,
  LIFT_DELTA: 0.15,
  CONSENSUS_CEILING: 0.85,
  NOISE_FLOOR: 0.55,
  TWIN_MIX_RATIO: 0.3,
} as const;
