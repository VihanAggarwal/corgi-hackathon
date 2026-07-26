/**
 * Track A public surface. Tracks B and C import from here and nowhere else.
 *
 * Internals are deliberately not re-exported. If something you need is missing,
 * ask rather than deep-importing: a deep import is how the seam between tracks
 * stops being a seam.
 *
 * Nothing exported here may carry a number about a person (hard rule 1). The
 * types that do carry one, TwinLink and TwinComputation, are internal-only and
 * reach a client only through toClientTwinView.
 */

// ---------------------------------------------------------------------------
// Model: fitting a preference vector from duels
// ---------------------------------------------------------------------------

export {
  fitTheta,
  isThetaStable,
  predictPreference,
  populationPrior,
  type FitObservation,
  type FitOptions,
  type FitResult,
} from './model';

// ---------------------------------------------------------------------------
// Duel selection: which pair to show next
// ---------------------------------------------------------------------------

export {
  selectDuels,
  expectedInformation,
  passesPopulationGate,
  type DuelCandidate,
  type SelectOptions,
  type SelectedPair,
} from './duel-select';

// ---------------------------------------------------------------------------
// Twins
//
// computeTwins returns an INTERNAL structure carrying cosine, weight, and
// reliability. Never serialize it. toClientTwinView is the only shape that may
// cross a network boundary, and its type makes the leak a compile error rather
// than a review question.
// ---------------------------------------------------------------------------

export {
  computeTwins,
  cosineSimilarity,
  clusterDescriptor,
  toClientTwinView,
  type AccountProvenance,
  type TwinCandidate,
  type TwinSelf,
  type TwinComputationInput,
  type TwinComputation,
  type ClientTwinView,
  type IndependenceViolation,
  type RejectedSupporter,
} from './twins';

// ---------------------------------------------------------------------------
// Lift: the anti-blast gate
// ---------------------------------------------------------------------------

export {
  evaluateLift,
  computeLift,
  shrunkTwinRate,
  isBillboard,
  populationBaseline,
  LIFT_TUNING,
  type LiftInput,
  type LiftDecision,
  type LiftEvidence,
  type TwinRefusal,
  type TwinObservations,
  type PopulationObservations,
  type PopulationBaseline,
  type VenueOrderCount,
} from './lift';

// ---------------------------------------------------------------------------
// Palate region and the frontier
// ---------------------------------------------------------------------------

export {
  computeRegion,
  volumeGrowthFraction,
  scoreFrontier,
  rankFrontier,
  expansionForPacket,
  REGION_CONSTANTS,
  type RatedDish,
  type ComputedRegion,
  type FrontierCandidate,
  type FrontierScore,
  type ScoreOptions,
  type RegionOptions,
} from './region';

// ---------------------------------------------------------------------------
// Evidence packet: the privacy boundary
// ---------------------------------------------------------------------------

export {
  buildEvidencePacket,
  assertPacketIsClean,
  PacketInputError,
  PacketLeakError,
  type PacketInput,
  type PacketUserInput,
  type PacketDishInput,
  type TwinEvidenceInput,
  type ConstraintRecord,
  type LeakDenylist,
} from './packet';

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export {
  renderRecommendation,
  validateRendering,
  twinChannelAllowed,
  dryRunRender,
  splitSentences,
  RenderValidationError,
  type ValidationResult,
  type Violation,
  type ViolationCode,
  type RenderOptions,
  type GenerateRequest,
} from './render';

export {
  generatePalatePortrait,
  derivePortraitPacket,
  deriveUnflatteringCandidates,
  describeVolumeChange,
  verifyUnflattering,
  type PortraitInput,
  type PortraitLog,
  type PortraitOptions,
  type PortraitPacket,
  type PortraitDraft,
  type UnflatteringClaim,
  type UnflatteringKind,
  type VolumeChange,
} from './portrait';

export {
  anthropicClientOptions,
  hasModelCredentials,
  type AnthropicClientOptions,
} from './anthropic-client';

// ---------------------------------------------------------------------------
// The twin-support gate
//
// twins.ts and lift.ts each independently grew a twinSupportForPacket, and each
// enforces only half of hard rule 5:
//
//   twins.ts  knows the channel is enabled, the supporters are independent, and
//             a cluster descriptor exists. It takes lift on trust as a number.
//   lift.ts   knows the lift cleared LIFT_DELTA, the dish is not a billboard,
//             and there were enough observations to believe the estimate. It
//             takes the descriptor on trust as a string.
//
// Neither is sufficient alone, and exporting both under one name would let a
// caller satisfy the import while checking half the gate. So neither raw
// function is re-exported, and this is the only way to build twinSupport.
// ---------------------------------------------------------------------------

import type { EvidencePacket } from '../contracts/types';
import { CONSTANTS } from '../contracts/types';
import type { LiftDecision } from './lift';
import type { TwinComputation } from './twins';

/**
 * Build EvidencePacket.twinSupport, or undefined when the twin channel is not
 * permitted.
 *
 * Returns undefined, never a zeroed or flagged object, because hard rule 5 is
 * enforced by structural absence: if the field is missing the renderer has
 * nothing to mention, and no downstream code has to remember to check a flag.
 *
 * Requires BOTH gates to pass. Order of checks is cheapest-first.
 */
export function twinSupportForPacket(
  computation: TwinComputation,
  decision: LiftDecision,
): EvidencePacket['twinSupport'] | undefined {
  // Twins gate: enabled, independent supporters, k floor, descriptor exists.
  if (!computation.status.enabled) return undefined;
  if (computation.status.twinCount < CONSTANTS.K_FLOOR) return undefined;
  if (computation.clusterDescriptor === null) return undefined;

  // Lift gate: divergence, not a billboard, enough observations to believe it.
  if (decision.channel !== 'twin') return undefined;
  if (!decision.evidence.kFloorMet) return undefined;
  if (!(decision.evidence.lift > CONSTANTS.LIFT_DELTA)) return undefined;

  return {
    // The supporter count, which is the number the copy says out loud, not the
    // observation count.
    n: computation.status.twinCount,
    lift: decision.evidence.lift,
    kFloorMet: true,
    clusterDescriptor: computation.clusterDescriptor,
  };
}
