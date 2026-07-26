/**
 * The lift gate. Track A. This is the anti-blast core.
 *
 *     lift(d) = P(positive | twins of u) - P(positive | population)
 *
 * A dish may be spoken about in the language of twins ("six people who share
 * your thing about sweetness picked this") only when the people who resemble
 * this user like it MORE than the room does. If everyone likes it, the sentence
 * "people like you liked this" is technically true and completely uninformative:
 * it is a billboard wearing a friend's voice. That is the exact failure this
 * file exists to make impossible.
 *
 * THE GATE HAS THREE INDEPENDENT PARTS AND ALL THREE MUST HOLD
 *   1. lift > CONSTANTS.LIFT_DELTA. Divergence, not popularity.
 *   2. k >= CONSTANTS.K_FLOOR distinct supporting twins. Anonymity and honesty.
 *   3. A population baseline built on enough observations to mean anything.
 *      Lift measured against a baseline of three people is not lift, it is the
 *      difference between two guesses.
 *
 * WHY A BILLBOARD PROVABLY CANNOT PASS
 * Twin rate cannot exceed 1, so lift is bounded above by 1 - populationRate.
 * Once the population rate reaches 1 - LIFT_DELTA the gate is arithmetically
 * unreachable no matter how many twins adore the dish. CONSENSUS_CEILING is
 * 0.85 and LIFT_DELTA is 0.15, so that bound lands exactly on the consensus
 * ceiling used by duel selection. The two rules agree by construction, which is
 * the point: an item everyone agrees on teaches us nothing about anyone.
 *
 * REFUSAL IS NOT REJECTION
 * Failing the gate never means the dish is bad or unrecommendable. It means the
 * twin FRAMING is not earned. The dish falls through to the content channel and
 * gets recommended as a safe pick instead, which is honest and is often what the
 * user wants. Hard rule 5 is about what we are allowed to say, not about what we
 * are allowed to serve.
 *
 * HARD RULE 1 NOTE
 * Everything here is a number about a dish and a room, never about a person.
 * `lift` and `n` describe an item and a headcount. No similarity score, match
 * percentage, or reliability figure leaves this file, and none should ever be
 * derived from what does.
 */

import { CONSTANTS, type EvidencePacket } from '../contracts/types';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface TwinObservations {
  /**
   * Distinct twins who have logged this dish. ONE ROW PER PERSON: the caller
   * must collapse repeat visits before calling, because one enthusiast eating
   * something five times is one person, not five, and treating it as five is
   * exactly how a single account manufactures a twin recommendation.
   */
  n: number;
  /** How many of those rated it positive. This count IS k for the k floor. */
  positive: number;
}

export interface PopulationObservations {
  /** Distinct people who logged this dish anywhere in the population. */
  n: number;
  positive: number;
}

/** One dish and how often the room orders it, for the venue baseline. */
export interface VenueOrderCount {
  dishName: string;
  orders: number;
}

export interface LiftInput {
  twin: TwinObservations;
  population: PopulationObservations;
  /**
   * What the room actually orders at this venue. Optional, because plenty of
   * venues have no order data, and the divergence sentence is then simply not
   * available rather than invented.
   */
  venueOrders?: VenueOrderCount[];
}

export interface PopulationBaseline {
  topDishName: string;
  topDishShare: number;
}

// ---------------------------------------------------------------------------
// Tuning owned by Track A. Deliberately local rather than added to CONSTANTS,
// which is a frozen cross-track contract.
// ---------------------------------------------------------------------------

export const LIFT_TUNING = {
  /**
   * Pseudo-observations of the POPULATION rate mixed into the twin estimate.
   *
   * The twin rate is shrunk toward the population rate, not toward 0.5, because
   * the null hypothesis being tested is precisely "these people behave like
   * everyone else". Shrinking toward the null makes small samples produce lift
   * near zero, so noise fails closed instead of failing loud.
   *
   * At 5, a twin cluster must out-vote an imaginary K_FLOOR-sized sample of the
   * general population before it is believed. Concretely, two twins out of two
   * against a population rate of 0.30 estimates 0.50, not 1.00, which is the
   * honest reading of two data points.
   */
  TWIN_PRIOR_STRENGTH: 5,

  /**
   * Minimum twin observations before a lift is trusted at all.
   *
   * Equal to K_FLOOR by construction, since a cluster with fewer observations
   * than the k floor can never supply k supporters anyway. It stays a separate
   * check so the refusal reason can distinguish "almost nobody like you has
   * eaten this" from "they ate it and did not rate it positive". Those are
   * different facts and the copy is different for each.
   */
  MIN_TWIN_OBSERVATIONS: CONSTANTS.K_FLOOR,

  /**
   * Minimum population observations before the baseline is usable.
   *
   * Lift is a difference of two rates, so a noisy baseline poisons it just as
   * badly as a noisy twin rate, and it does so invisibly because the baseline
   * looks like the stable half of the subtraction.
   */
  MIN_POPULATION_OBSERVATIONS: 20,
} as const;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Why the twin channel was refused. Every one of these still permits content. */
export type TwinRefusal =
  /** The baseline itself is guesswork, so any lift against it is meaningless. */
  | 'population_baseline_too_small'
  /** So many people like it that the gate is arithmetically unreachable. */
  | 'universally_liked'
  /** Too few twins have eaten it for the estimate to exist. */
  | 'not_enough_twin_observations'
  /** Fewer than K_FLOOR twins actually endorsed it. */
  | 'k_floor_not_met'
  /** Twins like it, but not measurably more than the room does. */
  | 'no_divergence_from_population';

export interface LiftEvidence {
  /** Shrunk twin rate minus population rate. Can be negative. */
  lift: number;
  /** Raw positive/n among twins. Diagnostic only, never gated on. */
  rawTwinRate: number;
  /** The estimate the gate actually uses. */
  shrunkTwinRate: number;
  populationRate: number;
  /** Distinct twins who endorsed the dish. This is the k in the k floor. */
  k: number;
  twinObservations: number;
  populationObservations: number;
  kFloorMet: boolean;
  /** The largest lift this dish could reach if every remaining twin loved it. */
  maxPossibleLift: number;
  /** Absent when the venue has no usable order data. */
  populationBaseline?: PopulationBaseline;
}

/**
 * Which channel this dish has EARNED. The content channel is always available,
 * so `channel: 'content'` means "recommend it, just not in the voice of twins".
 */
export type LiftDecision =
  | {
      channel: 'twin';
      reason: 'twin_support_diverges_from_population';
      evidence: LiftEvidence;
    }
  | {
      channel: 'content';
      reason: TwinRefusal;
      evidence: LiftEvidence;
    };

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

function assertCounts(label: string, positive: number, n: number): void {
  // These are caller bugs that would otherwise show up as a rate above 1 and a
  // dish sailing through the gate, so they fail loudly rather than clamp.
  if (!Number.isInteger(n) || !Number.isInteger(positive)) {
    throw new Error(`${label}: counts must be integers, got ${positive}/${n}`);
  }
  if (n < 0 || positive < 0) {
    throw new Error(`${label}: counts must not be negative, got ${positive}/${n}`);
  }
  if (positive > n) {
    throw new Error(`${label}: positive ${positive} exceeds total ${n}`);
  }
}

/**
 * Twin rate shrunk toward the population rate.
 *
 * Guarantees the estimate lies strictly between the raw rate and the population
 * rate whenever the two differ, so no finite sample can report a rate of 1.
 */
export function shrunkTwinRate(
  positive: number,
  n: number,
  populationRate: number,
  priorStrength: number = LIFT_TUNING.TWIN_PRIOR_STRENGTH,
): number {
  assertCounts('twin', positive, n);
  return (positive + priorStrength * populationRate) / (n + priorStrength);
}

/**
 * Raw proportion, or 0 when there is nothing to divide.
 *
 * The population half is deliberately NOT smoothed. It is required to carry at
 * least MIN_POPULATION_OBSERVATIONS before it is used, and smoothing it toward
 * 0.5 would tilt the baseline for every dish in the corpus at once.
 */
function proportion(positive: number, n: number): number {
  return n > 0 ? positive / n : 0;
}

/**
 * lift(dish) = P(positive | twins) - P(positive | population).
 *
 * Uses the shrunk twin estimate, so 2 of 2 does not read as 100 percent.
 * Returns a signed number: negative means twins like it LESS than the room,
 * which is a real and useful result.
 */
export function computeLift(twin: TwinObservations, population: PopulationObservations): number {
  assertCounts('twin', twin.positive, twin.n);
  assertCounts('population', population.positive, population.n);
  const populationRate = proportion(population.positive, population.n);
  return shrunkTwinRate(twin.positive, twin.n, populationRate) - populationRate;
}

/**
 * Whether a dish is so widely liked that the twin gate cannot be reached.
 *
 * The twin rate cannot exceed 1, so lift cannot exceed 1 - populationRate. The
 * condition is therefore populationRate >= 1 - LIFT_DELTA, written that way
 * rather than as `1 - populationRate <= LIFT_DELTA` because the subtraction on
 * the right of the comparison is exact in floating point at the boundary and
 * the one on the left is not. This is a property of the room alone, so it holds
 * for every possible twin sample, which is what makes the exclusion provable
 * rather than empirical.
 */
export function isBillboard(populationRate: number): boolean {
  return populationRate >= 1 - CONSTANTS.LIFT_DELTA;
}

// ---------------------------------------------------------------------------
// The population baseline: what the room actually orders
// ---------------------------------------------------------------------------

/**
 * Top dish at a venue and its share of orders.
 *
 * Returns undefined rather than a weak guess when the venue has too little
 * order data, because the divergence sentence ("that is not what the room does
 * here") is only worth saying when the room is actually known. Ties break
 * alphabetically so the same data always produces the same sentence: a baseline
 * that flips between calls reads to a user as the product making things up.
 */
export function populationBaseline(orders: VenueOrderCount[]): PopulationBaseline | undefined {
  let total = 0;
  for (const o of orders) {
    if (!Number.isFinite(o.orders) || o.orders < 0) {
      throw new Error(`venue orders must be non-negative, got ${o.orders} for ${o.dishName}`);
    }
    total += o.orders;
  }
  if (total < LIFT_TUNING.MIN_POPULATION_OBSERVATIONS) return undefined;

  let top: VenueOrderCount | undefined;
  for (const o of orders) {
    if (!top || o.orders > top.orders || (o.orders === top.orders && o.dishName < top.dishName)) {
      top = o;
    }
  }
  if (!top || top.orders === 0) return undefined;

  return { topDishName: top.dishName, topDishShare: top.orders / total };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Decide which channel a dish has earned.
 *
 * Guarantees:
 *   - `channel: 'twin'` is returned ONLY when lift > LIFT_DELTA AND k >= K_FLOOR
 *     AND both sample floors are met. There is no other path to it.
 *   - A dish whose population rate is at or above 1 - LIFT_DELTA never returns
 *     the twin channel, for any twin sample whatsoever.
 *   - The content channel is always permitted, so callers never have to handle
 *     "no channel available".
 *
 * Refusal reasons are ordered structural-first. A structural refusal will not
 * change when more data arrives, so reporting it first stops the caller from
 * promising the user that twins are coming when they never can.
 */
export function evaluateLift(input: LiftInput): LiftDecision {
  const { twin, population } = input;
  assertCounts('twin', twin.positive, twin.n);
  assertCounts('population', population.positive, population.n);

  const populationRate = proportion(population.positive, population.n);
  const rawTwinRate = proportion(twin.positive, twin.n);
  const shrunk = shrunkTwinRate(twin.positive, twin.n, populationRate);
  const lift = shrunk - populationRate;
  const k = twin.positive;
  const kFloorMet = k >= CONSTANTS.K_FLOOR;

  const evidence: LiftEvidence = {
    lift,
    rawTwinRate,
    shrunkTwinRate: shrunk,
    populationRate,
    k,
    twinObservations: twin.n,
    populationObservations: population.n,
    kFloorMet,
    maxPossibleLift: 1 - populationRate,
    populationBaseline: input.venueOrders ? populationBaseline(input.venueOrders) : undefined,
  };

  const refuse = (reason: TwinRefusal): LiftDecision => ({
    channel: 'content',
    reason,
    evidence,
  });

  if (population.n < LIFT_TUNING.MIN_POPULATION_OBSERVATIONS) {
    return refuse('population_baseline_too_small');
  }
  if (isBillboard(populationRate)) {
    // Reported before the twin floors because it is true regardless of them.
    return refuse('universally_liked');
  }
  if (twin.n < LIFT_TUNING.MIN_TWIN_OBSERVATIONS) {
    return refuse('not_enough_twin_observations');
  }
  if (!kFloorMet) {
    return refuse('k_floor_not_met');
  }
  if (!(lift > CONSTANTS.LIFT_DELTA)) {
    return refuse('no_divergence_from_population');
  }

  return { channel: 'twin', reason: 'twin_support_diverges_from_population', evidence };
}

// ---------------------------------------------------------------------------
// Handoff to the evidence packet
// ---------------------------------------------------------------------------

/**
 * Build the `twinSupport` block of an EvidencePacket, or undefined.
 *
 * Callers must go through this rather than assembling the block themselves.
 * Hard rule 5 says the UI must say nothing at all about twins below the floor,
 * and the only durable way to enforce that is to make the field structurally
 * absent: if the gate refused, there is no object for the renderer to speak
 * from, so an invented twin sentence has nothing to be grounded in.
 *
 * `n` is the SUPPORTER count, not the observation count, because that is the
 * number the copy says out loud. Saying "six people" when four of them disliked
 * it would be a lie told with a true number.
 */
export function twinSupportForPacket(
  decision: LiftDecision,
  clusterDescriptor: string,
): EvidencePacket['twinSupport'] | undefined {
  if (decision.channel !== 'twin') return undefined;
  return {
    n: decision.evidence.k,
    lift: decision.evidence.lift,
    kFloorMet: decision.evidence.kFloorMet,
    clusterDescriptor,
  };
}

export const __testing = { proportion, assertCounts };
