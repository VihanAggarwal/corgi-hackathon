/**
 * The evidence packet builder. Track A.
 *
 * THIS FILE IS THE PRIVACY BOUNDARY OF THE PRODUCT.
 *
 * Everything upstream of here works with real records: user ids, device ids,
 * dietary and religious constraints, twin links carrying reliability scores.
 * Everything downstream of here is a prompt, a rendered sentence, or a screen.
 * The packet is the only object that crosses, so anything that must never be
 * spoken has to die in this file, not in a prompt instruction and not in a
 * component that remembers to omit a field.
 *
 * The design follows from three of the hard rules:
 *
 *   Rule 1, numbers about places only. The packet carries numbers about the
 *   dish, the room, and the user's own axis values. It carries no number that
 *   describes another human being: no reliability, no cosine, no match score.
 *
 *   Rule 2, the LLM renders and never decides. Every decision (which axes
 *   drove this, did the twin channel fire, how confident are we) is made here
 *   and lands as a field. The renderer has nothing left to decide.
 *
 *   Rule 3, constraints are filters. Callers may hand us the constraint records
 *   because that is what they have in hand. They leave as a single integer.
 *
 * WHY THE ASSERTION EXISTS EVEN THOUGH BUILD IS THE ONLY WRITER
 * A leak here is silent, permanent, and unrecoverable: it lands in a message
 * thread. Type checking cannot catch a user id concatenated into a cluster
 * descriptor upstream, and a reviewer cannot catch it either. So the built
 * packet is walked at runtime, on every build, and a suspect value throws
 * rather than ships. Failing to produce a recommendation is a bad afternoon.
 * Naming a stranger's dietary restriction in a text message is the end of the
 * product.
 */

import { AXES, AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../contracts/axes';
import {
  CONSTANTS,
  type Conf24,
  type EvidencePacket,
  type TwinLink,
  type Vec24,
} from '../contracts/types';

// ---------------------------------------------------------------------------
// Input. Deliberately permissive: callers pass the rows they already have.
// ---------------------------------------------------------------------------

export interface PacketUserInput {
  /**
   * Accepted so a caller can pass their row straight in, and immediately
   * discarded. Present here on purpose: a builder that refused to accept an id
   * would push the stripping job onto every caller, and one of them would
   * forget.
   */
  userId?: string;
  deviceId?: string;
  theta: Vec24;
  /**
   * Population percentile per axis, 0..100. When absent it is derived from the
   * z-scored theta, which is what the axis contract says theta already is.
   */
  axisPercentiles?: number[];
  /** Fit size and posterior variance, used only to cap packet confidence. */
  nComparisons?: number;
  posteriorVar?: number;
}

export interface PacketDishInput {
  dishId?: string;
  venueId?: string;
  name: string;
  venueName: string;
  neighborhood: string;
  priceCents: number | null;
  phi: Vec24;
  /** Per-axis extraction confidence. Axes below CONF_THRESHOLD are masked. */
  confidence?: Conf24;
  /** Axes the extractor already marked unusable. Unioned with the above. */
  maskedAxes?: AxisKey[];
}

/**
 * Raw twin evidence. The supporters array may carry reliability and cosine.
 * Both are numbers about people, so both stop here.
 */
export interface TwinEvidenceInput {
  supporters?: TwinLink[];
  /** Independent supporter count. Falls back to supporters.length. */
  n?: number;
  /** P(positive|twins) - P(positive|population). */
  lift: number;
  /** What defines the cluster, in axis language. Never an identity. */
  clusterDescriptor: string;
}

/**
 * Article 9 special category data. Accepted in any shape a caller has, counted,
 * and then used as a denylist for the leak scan. Never propagated.
 *
 * The named fields are the shape we expect; the open record arm is there because
 * callers pass the row they have, and a row from a different table spells the
 * value `constraint_value` or `detail.text` rather than `value`. The denylist is
 * harvested from every string in the record, at every depth, precisely so that a
 * field name we did not predict cannot silently empty the denylist.
 */
export type ConstraintRecord =
  | string
  | { kind?: string; value?: string; label?: string; note?: string }
  | Record<string, unknown>;

export interface PacketInput {
  user: PacketUserInput;
  dish: PacketDishInput;
  twin?: TwinEvidenceInput;
  populationBaseline?: { topDishName: string; topDishShare: number };
  caveats?: Array<{ source: 'twin_note' | 'extraction' | 'venue_data'; n: number; claim: string }>;
  expansion?: { outsideRegion: boolean; axis: AxisKey; distance: 'adjacent' | 'far' };
  /** The channel the caller believes this came from. May be downgraded here. */
  sourceChannel: EvidencePacket['sourceChannel'];
  /** Constraint records, or a bare count if that is all the caller has. */
  constraints?: ConstraintRecord[];
  constraintsAppliedCount?: number;
  /** Overrides the derived value. Only ever used to lower confidence. */
  confidence?: EvidencePacket['confidence'];
}

/** Thrown when the input cannot produce an honest packet. */
export class PacketInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketInputError';
  }
}

/** Thrown when a built packet fails the privacy or grounding scan. */
export class PacketLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketLeakError';
  }
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/**
 * A contribution below this is not a driver, it is float noise. A new user with
 * a zero theta must produce zero driving axes rather than three arbitrary ones,
 * because "these axes drove it" would then be a claim we cannot support.
 */
const DRIVER_EPSILON = 1e-6;

function erf(x: number): number {
  // Abramowitz and Stegun 7.1.26. Error under 1.5e-7, which is invisible once
  // the result is rounded to a whole percentile.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Percentile of a z-scored axis value, 0..100. */
function percentileFromZ(z: number): number {
  const p = 50 * (1 + erf(z / Math.SQRT2));
  return clamp(Math.round(p), 0, 100);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function axisLabel(key: AxisKey): string {
  const found = AXES.find((a) => a.key === key);
  if (!found) throw new PacketInputError(`Unknown axis: ${key}`);
  return found.label;
}

const CONFIDENCE_RANK: Record<EvidencePacket['confidence'], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function weakest(...levels: Array<EvidencePacket['confidence']>): EvidencePacket['confidence'] {
  return levels.reduce((a, b) => (CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a), 'high');
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/**
 * Indices we are not allowed to speak about for this dish.
 *
 * The extractor gives us both a confidence vector and a masked list, and they
 * can disagree after a re-extraction. We take the union rather than trusting
 * either, because the cost of speaking about an axis we did not measure is a
 * confident sentence that is simply false.
 */
function maskedIndices(dish: PacketDishInput): Set<number> {
  const masked = new Set<number>();
  for (const key of dish.maskedAxes ?? []) {
    const i = AXIS_KEYS.indexOf(key);
    if (i >= 0) masked.add(i);
  }
  if (dish.confidence) {
    for (let i = 0; i < AXIS_COUNT; i++) {
      if (!(dish.confidence[i] >= CONSTANTS.CONF_THRESHOLD)) masked.add(i);
    }
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Driving axes
// ---------------------------------------------------------------------------

interface AxisContribution {
  index: number;
  key: AxisKey;
  contribution: number;
}

/**
 * The axes that actually drove the score, ranked.
 *
 * The score this system ranks on is theta . phi, so axis i contributed exactly
 * theta[i] * phi[i]. Only positive contributions are drivers: a strongly
 * negative term is an axis the dish LOST on, and handing it to the renderer as
 * a reason would invert the meaning of the sentence. Masked axes never appear,
 * because we did not measure them on this dish.
 */
function rankContributions(
  theta: Vec24,
  phi: Vec24,
  masked: Set<number>,
): AxisContribution[] {
  const out: AxisContribution[] = [];
  for (let i = 0; i < AXIS_COUNT; i++) {
    if (masked.has(i)) continue;
    const contribution = theta[i] * phi[i];
    if (contribution <= DRIVER_EPSILON) continue;
    out.push({ index: i, key: AXIS_KEYS[i], contribution });
  }
  out.sort((a, b) => b.contribution - a.contribution);
  return out;
}

const MAX_DRIVING_AXES = 3;

/**
 * Pick at most three driving axes.
 *
 * The expansion axis is forced in when the pick is outside the user's known
 * region, because under the expansion objective that axis IS the reason for the
 * recommendation even when its contribution is small or negative. Leaving it
 * out would give the renderer an `expansion` field with nothing to say about it.
 */
function selectDrivingAxes(
  ranked: AxisContribution[],
  theta: Vec24,
  phi: Vec24,
  expansionAxis: AxisKey | null,
): EvidencePacket['userAxes'] {
  const chosen = ranked.slice(0, MAX_DRIVING_AXES);

  if (expansionAxis && !chosen.some((c) => c.key === expansionAxis)) {
    const index = AXIS_KEYS.indexOf(expansionAxis);
    if (index >= 0) {
      // Displaces the weakest driver rather than extending past three. Three is
      // the ceiling because a recommendation that cites four reasons reads as a
      // sales pitch, and the fourth reason is always the weakest one.
      if (chosen.length >= MAX_DRIVING_AXES) chosen.pop();
      chosen.push({ index, key: expansionAxis, contribution: theta[index] * phi[index] });
      chosen.sort((a, b) => b.contribution - a.contribution);
    }
  }

  return chosen.map((c) => ({
    axis: c.key,
    label: axisLabel(c.key),
    // Rounded on purpose. A full precision float is a quasi-identifier: it is
    // effectively unique to one person's fit, and nothing downstream needs more
    // resolution than "minus two point one".
    value: round(theta[c.index], 2),
    percentile: percentileFromZ(theta[c.index]),
  }));
}

// ---------------------------------------------------------------------------
// Twin gate
// ---------------------------------------------------------------------------

/**
 * Hard rule 5. Returns the twinSupport block, or null when the channel did not
 * fire and the packet must not contain the key at all.
 *
 * The lift is rounded BEFORE the gate is applied so the packet is self
 * consistent: a packet that says lift 0.15 while claiming to have passed a
 * "greater than 0.15" gate is a packet whose numbers argue with each other.
 */
function gateTwinSupport(twin: TwinEvidenceInput | undefined): EvidencePacket['twinSupport'] | null {
  if (!twin) return null;

  const n = twin.n ?? twin.supporters?.length ?? 0;
  if (!Number.isFinite(n) || n < CONSTANTS.K_FLOOR) return null;

  const lift = round(twin.lift, 3);
  if (!Number.isFinite(lift) || lift <= CONSTANTS.LIFT_DELTA) return null;

  const clusterDescriptor = twin.clusterDescriptor.trim();
  // A cluster we cannot describe in axis language is a cluster we cannot
  // mention. The alternative is the renderer inventing what the group has in
  // common, which is rule 2 broken in the most convincing possible way.
  if (clusterDescriptor.length === 0) return null;

  return {
    n: Math.round(n),
    lift,
    kFloorMet: true,
    clusterDescriptor,
  };
}

// ---------------------------------------------------------------------------
// Constraint counting
// ---------------------------------------------------------------------------

/** Depth and size caps so a cyclic or enormous row cannot hang the builder. */
const CONSTRAINT_SCAN_MAX_DEPTH = 6;
const CONSTRAINT_SCAN_MAX_STRINGS = 512;

/**
 * Every string anywhere inside a constraint record.
 *
 * Reading only `kind`, `value`, `label`, `note` was a hole with the shape of a
 * silent failure: a caller passing `{ constraint_value: 'kosher' }` produced an
 * EMPTY denylist, the count still came out right, and the scan then waved
 * through a caveat claim that said "kosher" out loud. The denylist is the only
 * thing standing between an Article 9 value and a prompt, so it is built from
 * what the record contains rather than from what we hoped it would be called.
 *
 * A key is harvested only when its value is exactly `true`, which is the
 * `{ halal: true }` flag shape where the key IS the datum. Harvesting key names
 * unconditionally would put the word "value" on the denylist and then every
 * packet carrying the axis label "value density" would throw.
 */
function harvestStrings(node: unknown, depth: number, out: string[], seen: Set<object>): void {
  if (out.length >= CONSTRAINT_SCAN_MAX_STRINGS || depth > CONSTRAINT_SCAN_MAX_DEPTH) return;
  if (typeof node === 'string') {
    if (node.trim().length > 0) out.push(node);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) harvestStrings(item, depth + 1, out, seen);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value === true) harvestStrings(key, depth + 1, out, seen);
    harvestStrings(value, depth + 1, out, seen);
  }
}

function constraintStrings(records: ConstraintRecord[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  for (const r of records ?? []) harvestStrings(r, 0, out, seen);
  return out;
}

function resolveConstraintCount(input: PacketInput): number {
  // A non-array here is not a typo to be tolerated. `constraints: 'kosher'`
  // iterates as six characters: the count comes out as 6 and the denylist comes
  // out empty, which is the worst of both.
  if (input.constraints != null && !Array.isArray(input.constraints)) {
    throw new PacketInputError('constraints must be an array of records');
  }
  const fromRecords = input.constraints?.length;
  const explicit = input.constraintsAppliedCount;

  if (explicit != null && fromRecords != null && explicit !== fromRecords) {
    // Two sources of truth that disagree. Picking one would be a guess about
    // Article 9 data, and the count is the single thing about constraints we
    // are allowed to publish, so it has to be right or absent.
    throw new PacketInputError(
      `constraintsAppliedCount ${explicit} disagrees with ${fromRecords} constraint records`,
    );
  }
  const count = explicit ?? fromRecords ?? 0;
  if (!Number.isInteger(count) || count < 0) {
    throw new PacketInputError(`constraintsAppliedCount must be a non-negative integer`);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build an EvidencePacket.
 *
 * Guarantees, all enforced at runtime before the value is returned:
 *   - contains no user id, device id, dish id, venue id, constraint value,
 *     constraint kind, reliability score, cosine, or raw record
 *   - contains at most three driving axes, chosen by contribution to the score
 *   - omits `twinSupport` as a KEY when the k floor or the lift gate fails
 *   - reports constraints only as a non-negative integer count
 *   - never speaks about an axis that was masked on this dish
 *
 * Throws PacketInputError on unusable input and PacketLeakError when the built
 * packet fails the scan. Callers should treat a throw as "recommend something
 * else", not as something to catch and ignore.
 */
export function buildEvidencePacket(input: PacketInput): EvidencePacket {
  const { user, dish } = input;

  if (user.theta.length !== AXIS_COUNT) {
    throw new PacketInputError(`theta must have ${AXIS_COUNT} entries`);
  }
  if (dish.phi.length !== AXIS_COUNT) {
    throw new PacketInputError(`phi must have ${AXIS_COUNT} entries`);
  }
  if (user.axisPercentiles && user.axisPercentiles.length !== AXIS_COUNT) {
    throw new PacketInputError(`axisPercentiles must have ${AXIS_COUNT} entries`);
  }
  if (dish.name.trim().length === 0 || dish.venueName.trim().length === 0) {
    throw new PacketInputError('dish name and venue name are required');
  }

  const masked = maskedIndices(dish);
  const ranked = rankContributions(user.theta, dish.phi, masked);

  // An expansion claim about a masked axis is a claim about something we did
  // not measure, so the whole expansion block drops rather than the axis being
  // silently swapped for another one.
  const expansionAxisIndex = input.expansion ? AXIS_KEYS.indexOf(input.expansion.axis) : -1;
  const expansionUsable =
    input.expansion != null && expansionAxisIndex >= 0 && !masked.has(expansionAxisIndex);

  const userAxes = selectDrivingAxes(
    ranked,
    user.theta,
    dish.phi,
    expansionUsable && input.expansion!.outsideRegion ? input.expansion!.axis : null,
  );

  // Caller supplied percentiles win, because a measured population percentile
  // beats the normal approximation whenever one exists.
  if (user.axisPercentiles) {
    for (const entry of userAxes) {
      const i = AXIS_KEYS.indexOf(entry.axis);
      entry.percentile = clamp(Math.round(user.axisPercentiles[i]), 0, 100);
    }
  }

  const twinSupport = gateTwinSupport(input.twin);

  // Hard rule 5, applied to the channel as well as the block. `sourceChannel`
  // is itself a groundable field: a renderer told the channel is "twin" will
  // write a sentence about other people even with no twinSupport to cite. Below
  // the floor there are, as far as this packet is concerned, no twins.
  const sourceChannel: EvidencePacket['sourceChannel'] =
    input.sourceChannel === 'twin' && !twinSupport ? 'content' : input.sourceChannel;

  const caveats = sanitizeCaveats(input.caveats, twinSupport != null);
  const phiConfidence = derivePhiConfidence(dish, userAxes, masked);
  const confidence = deriveConfidence(input, phiConfidence);

  const packet: EvidencePacket = {
    userAxes,
    dish: {
      name: dish.name.trim(),
      venueName: dish.venueName.trim(),
      neighborhood: dish.neighborhood.trim(),
      priceCents: dish.priceCents == null ? null : Math.round(dish.priceCents),
      phiConfidence,
    },
    // Spread, never assignment. `twinSupport: undefined` would still create the
    // key, and `'twinSupport' in packet` is exactly what the renderer branches
    // on. Absent means absent.
    ...(twinSupport ? { twinSupport } : {}),
    ...(populationBaseline(input) ?? {}),
    caveats,
    ...(expansionUsable
      ? {
          expansion: {
            outsideRegion: input.expansion!.outsideRegion,
            axis: input.expansion!.axis,
            distance: input.expansion!.distance,
          },
        }
      : {}),
    sourceChannel,
    confidence,
    constraintsAppliedCount: resolveConstraintCount(input),
  };

  assertPacketIsClean(packet, collectForbiddenLiterals(input));
  return packet;
}

function populationBaseline(
  input: PacketInput,
): { populationBaseline: NonNullable<EvidencePacket['populationBaseline']> } | null {
  const b = input.populationBaseline;
  if (!b) return null;
  if (b.topDishName.trim().length === 0 || !Number.isFinite(b.topDishShare)) return null;
  return {
    populationBaseline: {
      topDishName: b.topDishName.trim(),
      topDishShare: round(clamp(b.topDishShare, 0, 1), 2),
    },
  };
}

/**
 * Caveats are mandatory in output when present, so a malformed one is worse
 * than a missing one: it becomes a sentence.
 *
 * twin_note caveats are dropped when the twin channel did not fire. A caveat
 * sourced from twins is itself a statement that twins exist and looked at this
 * dish, which is the thing rule 5 forbids below the floor.
 *
 * The source is checked against the contract's three values rather than only
 * compared to 'twin_note', because an equality test is a gate with a hole in it:
 * a row spelling the source "twin notes" or "twin_note " is not equal to
 * 'twin_note', so it survived the drop and carried a twin claim into the packet
 * below the k floor. An unrecognised source is a malformed caveat and leaves.
 */
const CAVEAT_SOURCES: ReadonlySet<string> = new Set(['twin_note', 'extraction', 'venue_data']);

function sanitizeCaveats(
  caveats: PacketInput['caveats'],
  twinChannelFired: boolean,
): EvidencePacket['caveats'] {
  const out: EvidencePacket['caveats'] = [];
  for (const c of caveats ?? []) {
    if (!CAVEAT_SOURCES.has(c.source)) continue;
    if (c.source === 'twin_note' && !twinChannelFired) continue;
    const claim = c.claim.trim();
    if (claim.length === 0) continue;
    if (!Number.isFinite(c.n) || c.n < 1) continue;
    out.push({ source: c.source, n: Math.round(c.n), claim });
  }
  return out;
}

/**
 * How well we know what this dish actually is, judged on the axes we are about
 * to speak about rather than on the vector as a whole. A dish extracted well
 * everywhere except the two axes in this packet is not a high confidence dish
 * for this packet.
 */
function derivePhiConfidence(
  dish: PacketDishInput,
  userAxes: EvidencePacket['userAxes'],
  masked: Set<number>,
): EvidencePacket['dish']['phiConfidence'] {
  if (!dish.confidence) {
    // No confidence vector at all. Medium: we will not claim high on a dish
    // whose extraction quality is unknown to us.
    return 'medium';
  }
  const indices = userAxes.length
    ? userAxes.map((a) => AXIS_KEYS.indexOf(a.axis))
    : [...Array(AXIS_COUNT).keys()].filter((i) => !masked.has(i));

  if (indices.length === 0) return 'low';
  const mean = indices.reduce((s, i) => s + (dish.confidence![i] ?? 0), 0) / indices.length;
  if (mean >= 0.85) return 'high';
  if (mean >= CONSTANTS.CONF_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Packet confidence is the weakest leg, not an average.
 *
 * A confident reading of a dish means nothing if we barely know the user, and
 * knowing the user perfectly means nothing if the dish vector is a guess. The
 * renderer hedges on `low`, so being wrong in the optimistic direction produces
 * an unhedged false sentence, which is the expensive error.
 */
function deriveConfidence(
  input: PacketInput,
  phiConfidence: EvidencePacket['dish']['phiConfidence'],
): EvidencePacket['confidence'] {
  const { nComparisons, posteriorVar } = input.user;

  let userConfidence: EvidencePacket['confidence'];
  if (nComparisons == null) {
    userConfidence = 'medium';
  } else if (
    nComparisons >= CONSTANTS.MIN_DUELS_FOR_THETA &&
    (posteriorVar == null || posteriorVar <= CONSTANTS.THETA_STABLE_VAR)
  ) {
    userConfidence = nComparisons >= CONSTANTS.MIN_DUELS_FOR_TWINS ? 'high' : 'medium';
  } else {
    userConfidence = 'low';
  }

  // A vision read of a menu photo is an inference about an inference.
  const channelConfidence: EvidencePacket['confidence'] =
    input.sourceChannel === 'agent_vision' ? 'medium' : 'high';

  const derived = weakest(phiConfidence, userConfidence, channelConfidence);

  // An override may only lower. A caller that knows something is wrong can say
  // so, but nobody gets to talk this number up.
  return input.confidence ? weakest(derived, input.confidence) : derived;
}

// ---------------------------------------------------------------------------
// The leak scan
// ---------------------------------------------------------------------------

/**
 * Allowed keys per node, derived from contracts/evidence-packet.schema.json.
 * Array elements normalise to a `[]` path segment.
 *
 * An allowlist rather than a denylist, because a denylist only defends against
 * the leaks somebody already thought of.
 */
const ALLOWED_KEYS: Record<string, ReadonlySet<string>> = {
  '': new Set([
    'userAxes',
    'dish',
    'twinSupport',
    'populationBaseline',
    'caveats',
    'expansion',
    'sourceChannel',
    'confidence',
    'constraintsAppliedCount',
  ]),
  'userAxes[]': new Set(['axis', 'label', 'value', 'percentile']),
  dish: new Set(['name', 'venueName', 'neighborhood', 'priceCents', 'phiConfidence']),
  twinSupport: new Set(['n', 'lift', 'kFloorMet', 'clusterDescriptor']),
  populationBaseline: new Set(['topDishName', 'topDishShare']),
  'caveats[]': new Set(['source', 'n', 'claim']),
  expansion: new Set(['outsideRegion', 'axis', 'distance']),
};

/**
 * Key shapes that are never acceptable anywhere, checked in addition to the
 * allowlist so that a future field added to the schema cannot quietly bring an
 * identity or a number about a person with it.
 */
// Case sensitive on the camel-case arm on purpose. A case-insensitive `id$`
// would reject honest words like "valid" and "hybrid".
const IDENTIFIER_KEY_RE = /^id$|_id$|[a-z0-9](Id|Ids)$/;

function looksLikeIdentifierKey(key: string): boolean {
  const lower = key.toLowerCase();
  return IDENTIFIER_KEY_RE.test(key) || lower.includes('uuid') || lower.includes('guid');
}

const PERSON_METRIC_KEY_RE =
  /reliab|cosine|similar|matchscore|matchpercent|constraint|allerg|dietary|kosher|halal|device|email|phone|handle|username/i;

/** uuid v1 through v8, in any casing, anywhere inside a string. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Long opaque runs: mongo object ids, hashes, base64ish row keys. */
const LONG_OPAQUE_RE = /\b[0-9a-f]{24,}\b/i;
/**
 * Prefixed keys of the `usr_9fA3...` / `dev-8827...` family. The suffix must
 * contain a digit, otherwise the axis key `protein_prominence` and ordinary
 * hyphenated prose would read as identifiers.
 */
const PREFIXED_ID_RE = /\b[A-Za-z]{2,12}[_-](?=[A-Za-z0-9]{10,}\b)[A-Za-z0-9]*\d[A-Za-z0-9]*\b/;

/**
 * The whole string is an id and nothing else.
 *
 * Anchored rather than reusing the search patterns above: a constraint value
 * recorded as "peanut allergy (row 3f2504e0-4f89-11d3-9a0c-0305e82c3301)"
 * contains an id, and treating the whole thing as an id would skip tokenization
 * and quietly drop "peanut" from the denylist.
 */
function isWhollyIdentifierShaped(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^[0-9a-f]{24,}$/i.test(value) ||
    /^[A-Za-z]{2,12}[_-][A-Za-z0-9]{10,}$/.test(value)
  );
}

/**
 * Article 9 vocabulary, checked against every string in the packet regardless of
 * what the caller handed us.
 *
 * The denylist above can only catch a value we were given. A caller that passes
 * `constraintsAppliedCount: 2` and no records, which the input type explicitly
 * allows, gets an empty denylist, and a cluster descriptor reading "people who,
 * like you, keep halal" then sails through into the prompt. These words are the
 * ones that can only be about a person's declared restriction, so they are
 * refused on sight rather than compared against anything.
 *
 * Word boundaries, not substrings: "kosher" is refused, "coshered" is not.
 *
 * Duplicated from the renderer's output filter on purpose. The boundary cannot
 * import from the thing it exists to protect, and a dish this list blocks is a
 * dish the renderer's own filter would have rejected after the model call, which
 * is one prompt too late.
 *
 * The cost is real and accepted: a dish genuinely named "vegan mapo tofu" cannot
 * be recommended by this system at all. A lost candidate is recoverable. Putting
 * the word "kosher" next to a specific person's recommendation is not.
 */
const ARTICLE_9_TERMS: RegExp[] = [
  /\bhalal\b/i,
  /\bkashrut\b/i,
  /\bkosher\b/i,
  /\bvegan\b/i,
  /\bvegetarian\b/i,
  /\bpescatarian\b/i,
  /\bceliac\b/i,
  /\bcoeliac\b/i,
  /\blactose\b/i,
  /\ballerg(?:y|ies|en|ens|ic)\b/i,
  /\bintoleran(?:t|ce)\b/i,
  /\b(?:gluten|dairy|nut|peanut|egg|soy|shellfish|lactose)[- ]?free\b/i,
  /\bdietary (?:restriction|requirement|need|law)/i,
  /\breligious (?:restriction|requirement|observance|dietary)/i,
];

/**
 * Tokens too generic to treat as evidence of a constraint leak. Without this,
 * a constraint recorded as "dairy free" would flag every dish described as
 * free range.
 *
 * The list is what does the work, not the token length. A length floor of four
 * was doing the filtering before, and it silently exempted `soy`, `nut`, and
 * `egg`: "nut allergy" produced the needle "allergy" and nothing that would
 * catch a dish named "nut brittle". Those three are among the most common
 * declared allergens in the product, so the floor is three and the words that
 * genuinely carry no dietary meaning are named here instead.
 */
const GENERIC_CONSTRAINT_TOKENS = new Set([
  'free',
  'none',
  'only',
  'diet',
  'food',
  'other',
  'and',
  'any',
  'all',
  'are',
  'but',
  'can',
  'for',
  'has',
  'may',
  'not',
  'per',
  'the',
  'use',
  'via',
  'with',
  'without',
  'from',
  'that',
  'this',
  'they',
  'their',
  'user',
  'note',
  'kind',
  'type',
  'name',
  'label',
  'value',
  'level',
  'strict',
  'avoid',
  'prefer',
  'allowed',
]);

/** Below this a token is a fragment, not a word. */
const CONSTRAINT_TOKEN_FLOOR = 3;

/**
 * Two kinds of denied string, matched differently on purpose.
 *
 * Ids are matched whole. A fragment of an id identifies nobody, and id prefixes
 * are ordinary words: tokenizing `venue_9931ktz8wq` produces "venue", which
 * then matches the caveat source `venue_data` and blocks every honest packet.
 *
 * Constraint values are matched by token as well as whole, because the leak we
 * are hunting is not the phrase "peanut allergy" appearing verbatim, it is the
 * word "peanut" appearing in a dish that the upstream filter should have
 * removed for this user.
 */
export interface LeakDenylist {
  exact?: readonly string[];
  tokenized?: readonly string[];
}

function buildNeedles(denylist: readonly string[] | LeakDenylist): string[] {
  // A bare array is the common case (constraint values), so it means tokenized.
  const list: LeakDenylist = Array.isArray(denylist)
    ? { tokenized: denylist as readonly string[] }
    : (denylist as LeakDenylist);
  const out = new Set<string>();

  for (const raw of list.exact ?? []) {
    const value = raw.trim().toLowerCase();
    if (value.length >= 3) out.add(value);
  }
  for (const raw of list.tokenized ?? []) {
    const value = raw.trim().toLowerCase();
    if (value.length >= 3) out.add(value);
    // An id that arrived inside a constraint row is matched whole, for the same
    // reason ids are always matched whole: its prefix is an ordinary word.
    if (isWhollyIdentifierShaped(value)) continue;
    for (const token of value.split(/[^a-z0-9]+/)) {
      if (token.length < CONSTRAINT_TOKEN_FLOOR) continue;
      if (GENERIC_CONSTRAINT_TOKENS.has(token)) continue;
      // A bare number is never a dietary or religious value, and a row id or a
      // timestamp fragment on the denylist is a false positive waiting for a
      // venue with a year in its name.
      if (!/[a-z]/.test(token)) continue;
      out.add(token);
    }
  }
  return [...out];
}

function collectForbiddenLiterals(input: PacketInput): LeakDenylist {
  const exact: string[] = [];
  const push = (v: string | undefined) => {
    if (typeof v === 'string' && v.trim().length > 0) exact.push(v);
  };

  push(input.user.userId);
  push(input.user.deviceId);
  push(input.dish.dishId);
  push(input.dish.venueId);
  for (const link of input.twin?.supporters ?? []) {
    push(link.userId);
    push(link.twinUserId);
  }
  return { exact, tokenized: constraintStrings(input.constraints) };
}

function normalizePath(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

interface ScanContext {
  forbidden: string[];
}

function scanString(value: string, path: string, ctx: ScanContext): void {
  if (UUID_RE.test(value)) {
    throw new PacketLeakError(`uuid-shaped value at ${path || '(root)'}`);
  }
  if (LONG_OPAQUE_RE.test(value) || PREFIXED_ID_RE.test(value)) {
    throw new PacketLeakError(`identifier-shaped value at ${path || '(root)'}`);
  }
  for (const term of ARTICLE_9_TERMS) {
    const hit = term.exec(value);
    if (hit) {
      throw new PacketLeakError(
        `special category vocabulary "${hit[0]}" at ${path || '(root)'}`,
      );
    }
  }
  const lower = value.toLowerCase();
  for (const literal of ctx.forbidden) {
    if (lower.includes(literal)) {
      // Deliberately fatal, and deliberately blunt. A constraint value showing
      // up in a dish name usually means the upstream set intersection did not
      // run, in which case this recommendation was going to violate someone's
      // restriction anyway. Losing a legitimate recommendation to a venue that
      // happens to be named after a dietary law is the cheaper mistake.
      throw new PacketLeakError(`forbidden input literal reached the packet at ${path || '(root)'}`);
    }
  }
}

function walk(node: unknown, path: string, ctx: ScanContext): void {
  if (node === null) return;

  switch (typeof node) {
    case 'string':
      scanString(node, path, ctx);
      return;
    case 'number':
      if (!Number.isFinite(node)) {
        throw new PacketLeakError(`non-finite number at ${path}, which serializes as null`);
      }
      return;
    case 'boolean':
      return;
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint. An undefined value means an
      // optional block was assigned rather than spread, and `'key' in packet`
      // would then be true for a block that did not fire.
      throw new PacketLeakError(`value of type ${typeof node} at ${path || '(root)'}`);
  }

  if (Array.isArray(node)) {
    for (const item of node) walk(item, `${path}[]`, ctx);
    return;
  }

  const allowed = ALLOWED_KEYS[path];
  if (!allowed) {
    throw new PacketLeakError(`unexpected nested object at ${path || '(root)'}`);
  }
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      throw new PacketLeakError(`key not in the packet contract: ${normalizePath(path, key)}`);
    }
    if (looksLikeIdentifierKey(key)) {
      throw new PacketLeakError(`identifier-shaped key: ${normalizePath(path, key)}`);
    }
    if (key !== 'constraintsAppliedCount' && PERSON_METRIC_KEY_RE.test(key)) {
      throw new PacketLeakError(`key describes a person: ${normalizePath(path, key)}`);
    }
    walk((node as Record<string, unknown>)[key], normalizePath(path, key), ctx);
  }
}

/**
 * Assert that a packet is safe to hand to a renderer.
 *
 * Checks, all of them deep rather than top level:
 *   - every key exists in the packet contract at its own path
 *   - no key is identifier-shaped or describes a person
 *   - no string value contains a uuid, a long opaque id, or a prefixed id
 *   - no string value contains a denied literal, or a meaningful token from a
 *     tokenized one, which is how constraint values and ids are caught
 *   - the hard-rule invariants: at most three driving axes, real axis keys,
 *     twinSupport only above the k floor and the lift delta, constraints only
 *     as a non-negative integer
 *
 * Throws PacketLeakError on the first violation. Callers must not catch and
 * continue.
 */
export function assertPacketIsClean(
  packet: unknown,
  denylist: readonly string[] | LeakDenylist = [],
): asserts packet is EvidencePacket {
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new PacketLeakError('packet must be an object');
  }

  walk(packet, '', { forbidden: buildNeedles(denylist) });
  assertHardRuleInvariants(packet as EvidencePacket);
}

const SOURCE_CHANNELS: ReadonlySet<string> = new Set(['twin', 'content', 'agent_vision']);
const CONFIDENCE_LEVELS: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const EXPANSION_DISTANCES: ReadonlySet<string> = new Set(['adjacent', 'far']);

/**
 * Every closed set in the contract, checked.
 *
 * The axis keys were already checked and the free-text enums were not, which
 * made them the one place a caller could write a sentence into the packet. A
 * `sourceChannel` of "twin_cluster_of_4_similar_diners" is not equal to 'twin',
 * so the rule 5 check below never fired, and the value still reached whatever
 * branches on the channel. A field with three legal values gets three legal
 * values.
 */
function assertEnums(packet: EvidencePacket): void {
  if (!SOURCE_CHANNELS.has(packet.sourceChannel)) {
    throw new PacketLeakError(`sourceChannel is not one of the contract's values`);
  }
  if (!CONFIDENCE_LEVELS.has(packet.confidence)) {
    throw new PacketLeakError(`confidence is not one of the contract's values`);
  }
  if (!CONFIDENCE_LEVELS.has(packet.dish.phiConfidence)) {
    throw new PacketLeakError(`dish.phiConfidence is not one of the contract's values`);
  }
  for (const c of packet.caveats) {
    if (!CAVEAT_SOURCES.has(c.source)) {
      throw new PacketLeakError(`caveat source is not one of the contract's values`);
    }
    if (!Number.isInteger(c.n) || c.n < 1) {
      throw new PacketLeakError('caveat n must be a positive integer');
    }
  }
  if (packet.expansion) {
    if (!EXPANSION_DISTANCES.has(packet.expansion.distance)) {
      throw new PacketLeakError(`expansion.distance is not one of the contract's values`);
    }
    if (typeof packet.expansion.outsideRegion !== 'boolean') {
      throw new PacketLeakError('expansion.outsideRegion must be a boolean');
    }
  }
}

/** The keys the contract marks required. A missing one is not a safe packet. */
const REQUIRED_KEYS = [
  'userAxes',
  'dish',
  'caveats',
  'sourceChannel',
  'confidence',
  'constraintsAppliedCount',
] as const;

function assertHardRuleInvariants(packet: EvidencePacket): void {
  for (const key of REQUIRED_KEYS) {
    if (!(key in packet)) {
      throw new PacketLeakError(`packet is missing the required key ${key}`);
    }
  }
  if (packet.dish === null || typeof packet.dish !== 'object' || !Array.isArray(packet.caveats)) {
    throw new PacketLeakError('dish must be an object and caveats an array');
  }
  assertEnums(packet);

  if (!Array.isArray(packet.userAxes) || packet.userAxes.length > MAX_DRIVING_AXES) {
    throw new PacketLeakError(`userAxes must contain at most ${MAX_DRIVING_AXES} entries`);
  }
  for (const entry of packet.userAxes) {
    if (!AXIS_KEYS.includes(entry.axis)) {
      throw new PacketLeakError(`userAxes contains an axis outside the contract: ${entry.axis}`);
    }
    // A relabelled axis is an ungrounded sentence waiting to happen: the
    // renderer is only allowed to say the contract's label out loud.
    if (entry.label !== axisLabel(entry.axis)) {
      throw new PacketLeakError(`userAxes label does not match the axis contract: ${entry.axis}`);
    }
    if (entry.percentile < 0 || entry.percentile > 100) {
      throw new PacketLeakError('percentile out of range');
    }
  }

  if ('twinSupport' in packet) {
    const t = packet.twinSupport;
    if (!t) throw new PacketLeakError('twinSupport key present without a value');
    if (t.n < CONSTANTS.K_FLOOR || t.kFloorMet !== true) {
      throw new PacketLeakError('twinSupport present below the k floor');
    }
    if (t.lift <= CONSTANTS.LIFT_DELTA) {
      throw new PacketLeakError('twinSupport present below the lift delta');
    }
  } else if (packet.sourceChannel === 'twin') {
    throw new PacketLeakError('sourceChannel claims twin with no twinSupport to cite');
  }

  if (!Number.isInteger(packet.constraintsAppliedCount) || packet.constraintsAppliedCount < 0) {
    throw new PacketLeakError('constraintsAppliedCount must be a non-negative integer');
  }

  if (packet.expansion && !AXIS_KEYS.includes(packet.expansion.axis)) {
    throw new PacketLeakError(`expansion names an axis outside the contract`);
  }
}

export const __testing = {
  percentileFromZ,
  rankContributions,
  maskedIndices,
  gateTwinSupport,
  buildNeedles,
  MAX_DRIVING_AXES,
};
