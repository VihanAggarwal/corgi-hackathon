/**
 * The palate portrait. Track A.
 *
 * Prose generated from theta plus dish logs. This is the only profile screen the
 * product has, and it is deliberately not a chart. Rule 1 says numbers about
 * places and never numbers about people, so a radar chart, an axis slider, or a
 * "you are 82% acid" readout are all banned by construction rather than by
 * discipline. Taste is rendered as language or it is not rendered.
 *
 * THE HOROSCOPE PROBLEM IS THE WHOLE ENGINEERING PROBLEM
 * Every generated-personality product converges on flattery, because flattery
 * is what a helpful model produces when it is asked to describe someone from
 * their own data. Flattery is unfalsifiable, so it is indistinguishable from a
 * horoscope, so the portrait proves nothing about whether the model knows
 * anything. The fix here is structural, not a line in a prompt:
 *
 *   1. The unflattering claim is DERIVED FROM THE DATA before generation. The
 *      model is handed a true criticism and told to rewrite it. It never gets
 *      to decide what the criticism is, which means it can never invent a
 *      flattering one.
 *   2. The claim lands in a KNOWN FIELD of a structured response, so the check
 *      runs against one sentence we can locate rather than against a paragraph
 *      we have to interpret.
 *   3. The check is an anchor phrase plus a polarity test, and it runs on our
 *      side. containsUnflattering is set from that check, never from the
 *      model's own claim that it complied.
 *   4. Failure retries, then throws. Shipping a portrait that only compliments
 *      is worse than shipping no portrait.
 *
 * A polarity lexicon is a weak signal on its own, which is exactly why it is
 * the last of the four and not the first.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicClientOptions, hasModelCredentials } from './anthropic-client';
import { AXES, AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../contracts/axes';
import {
  CONSTANTS,
  type PalatePortrait,
  type PalateRegion,
  type UserVector,
  type Vec24,
} from '../contracts/types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Voice quality matters more than cost here, and portrait volume is low. */
const RENDER_MODEL = 'claude-opus-5';

/**
 * Dry run. Same idea as the corpus pipeline: every code path is exercised with
 * deterministic synthetic output and zero network calls, so this is testable and
 * demoable before a key exists.
 *
 * The corpus DRY_RUN flag is deliberately not imported. It also gates on the
 * Places key, which rendering never uses, and it loads dotenv at import time,
 * which has no business running inside a Next request path.
 */
function dryRunEnabled(): boolean {
  if (process.env.PORTRAIT_DRY_RUN === '1') return true;
  if (process.env.PORTRAIT_DRY_RUN === '0') return false;
  // Gateway can hold the provider credential, so its URL alone is enough.
  return !hasModelCredentials();
}

/**
 * The portrait is four or five sentences at most. Past that it stops being a
 * read on a person and starts being a personality quiz result.
 */
const MAX_SENTENCES = 5;

/** One draft plus two retries. After that the failure is real and must surface. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Below this magnitude an axis is not an opinion, it is noise. */
const SIGNATURE_FLOOR = 0.35;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * A dish log joined with the dish name. DishLog carries only a dishId, and the
 * portrait needs concrete nouns, so the join happens in the caller.
 */
export interface PortraitLog {
  dishName: string;
  /** 1..5 */
  rating: number;
}

export interface PortraitInput {
  userId: string;
  user: UserVector;
  logs: PortraitLog[];
  /**
   * The region at the previous portrait and the region now. Passing the same
   * region twice is legal and is what a first portrait looks like: the volume
   * line then honestly reports no movement.
   */
  regionBefore: PalateRegion;
  regionAfter: PalateRegion;
  /** Population mean theta. Zero vector when there is no population yet. */
  populationPrior?: Vec24;
}

// ---------------------------------------------------------------------------
// The evidence the renderer is allowed to see
// ---------------------------------------------------------------------------

export type UnflatteringKind =
  | 'thin_evidence'
  | 'refused_axis'
  | 'narrow_region'
  | 'undiscriminating'
  | 'strong_rejection';

export interface UnflatteringClaim {
  kind: UnflatteringKind;
  /** A true sentence, written from the data. The model rewrites it, never invents it. */
  claim: string;
  /** Exact phrase the generated sentence must contain. This is the verification anchor. */
  anchor: string;
  /** Evidence strength. Highest wins. Internal, never sent to the model. */
  strength: number;
  axis?: AxisKey;
}

export interface VolumeChange {
  direction: 'grew' | 'flat' | 'shrank';
  /** Prose, no digits. Reads grammatically after "Your palate ". */
  phrase: string;
  /** The axis with no positive rating yet that the user is most set against. */
  refusedAxis: AxisKey | null;
  refusedLabel: string | null;
}

/**
 * The only object the renderer ever sees. It contains no identity, no
 * constraints, no ratings, and no numbers of any kind, which is why a leaked
 * digit in the output is provably the model inventing rather than reporting.
 */
export interface PortraitPacket {
  signature: Array<{
    axis: AxisKey;
    label: string;
    /** Which end of the axis they sit at. */
    direction: 'high' | 'low';
    /** The pole descriptor from the frozen axis table, e.g. "seriously hot". */
    pole: string;
    strength: 'defining' | 'strong' | 'mild';
  }>;
  favoriteDishes: string[];
  dislikedDishes: string[];
  unflattering: UnflatteringClaim;
  volume: VolumeChange;
  /** Axis names the renderer may speak. Any other axis name in the output is ungrounded. */
  allowedLabels: string[];
  thetaStable: boolean;
}

export interface PortraitDraft {
  opening: string;
  /** Exactly one sentence, and the one we verify. */
  unflattering: string;
  volume: string;
}

export type DraftGenerator = (
  packet: PortraitPacket,
  attempt: number,
  priorViolations: string[],
) => Promise<PortraitDraft> | PortraitDraft;

export interface PortraitOptions {
  /** Inject a drafter. Tests use this. Production leaves it unset. */
  draft?: DraftGenerator;
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Derivation: everything true is computed before the model is involved
// ---------------------------------------------------------------------------

function axisMeta(key: AxisKey) {
  const a = AXES.find((x) => x.key === key);
  if (!a) throw new Error(`Unknown axis: ${key}`);
  return a;
}

/**
 * A name we can put in prose without breaking the voice rules.
 *
 * A dish called "No. 7 Noodles" cannot be spoken without a digit, so it never
 * enters the packet at all. Filtering here is better than asking the renderer to
 * work around it and then failing the digit check on our own evidence.
 */
function speakable(name: string): boolean {
  const t = name.trim();
  return t.length > 0 && t.length <= 60 && !/\d/.test(t) && !t.includes('!');
}

function signatureAxes(theta: Vec24): PortraitPacket['signature'] {
  return theta
    .map((v, i) => ({ v, i }))
    .filter((x) => Math.abs(x.v) >= SIGNATURE_FLOOR)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || a.i - b.i)
    .slice(0, 3)
    .map(({ v, i }) => {
      const meta = axisMeta(AXIS_KEYS[i]);
      const mag = Math.abs(v);
      return {
        axis: meta.key as AxisKey,
        label: meta.label,
        direction: (v >= 0 ? 'high' : 'low') as 'high' | 'low',
        pole: v >= 0 ? meta.high : meta.low,
        strength: (mag >= 1.5 ? 'defining' : mag >= 0.8 ? 'strong' : 'mild') as
          | 'defining'
          | 'strong'
          | 'mild',
      };
    });
}

/**
 * Growth of the enjoyed region, as words.
 *
 * PalateRegion.volume is a LOG volume, so the honest comparison is the ratio
 * exp(after - before) rather than the difference. Reported in buckets and never
 * as a figure: "roughly doubled" is both truer to the precision we actually have
 * and permitted by rule 1, where "grew 87%" is neither.
 */
export function describeVolumeChange(
  before: PalateRegion,
  after: PalateRegion,
  theta?: Vec24,
): VolumeChange {
  const delta = after.volume - before.volume;
  const ratio = Number.isFinite(delta) ? Math.exp(delta) : 1;

  let phrase: string;
  let direction: VolumeChange['direction'];
  if (ratio >= 2.5) {
    phrase = 'has more than doubled';
    direction = 'grew';
  } else if (ratio >= 1.8) {
    phrase = 'has roughly doubled';
    direction = 'grew';
  } else if (ratio >= 1.4) {
    phrase = 'has grown by about half again';
    direction = 'grew';
  } else if (ratio >= 1.12) {
    phrase = 'has widened a little';
    direction = 'grew';
  } else if (ratio > 0.98) {
    phrase = 'has not really moved';
    direction = 'flat';
  } else if (ratio > 0.8) {
    phrase = 'has narrowed slightly';
    direction = 'shrank';
  } else {
    phrase = 'has narrowed';
    direction = 'shrank';
  }

  const refusedAxis = pickRefusedAxis(before, after, theta);
  return {
    direction,
    phrase,
    refusedAxis,
    refusedLabel: refusedAxis ? axisMeta(refusedAxis).label : null,
  };
}

/**
 * The axis they still will not touch.
 *
 * Prefer an axis that was on the frontier before AND is still on it now: that
 * is a refusal held across the whole window, not an axis they simply have not
 * reached yet. Among those, the one they push away hardest in duels.
 */
function pickRefusedAxis(
  before: PalateRegion,
  after: PalateRegion,
  theta?: Vec24,
): AxisKey | null {
  const stillFrontier = after.frontierAxes;
  if (stillFrontier.length === 0) return null;

  const heldBefore = new Set(before.frontierAxes);
  const persistent = stillFrontier.filter((k) => heldBefore.has(k));
  const pool = persistent.length > 0 ? persistent : stillFrontier;

  if (!theta) return pool[0];
  const scored = pool
    .map((k) => ({ k, t: theta[AXIS_KEYS.indexOf(k)] ?? 0 }))
    .sort((a, b) => a.t - b.t || AXIS_KEYS.indexOf(a.k) - AXIS_KEYS.indexOf(b.k));
  return scored[0].k;
}

/**
 * Derive every unflattering claim the data supports, strongest first.
 *
 * Nothing here is an opinion about the person. Each claim is a restatement of a
 * quantity we computed: how much evidence we have, what they have never once
 * accepted, whether the region moved, whether their ratings discriminate at all,
 * and which axis their loudest opinion pushes away.
 */
export function deriveUnflatteringCandidates(input: PortraitInput): UnflatteringClaim[] {
  const { user, logs, regionBefore, regionAfter } = input;
  const theta = user.theta;
  const out: UnflatteringClaim[] = [];

  // 1. Thin evidence outranks everything. If we barely know them, saying
  //    anything sharper would be the model inventing a person.
  if (user.nComparisons < CONSTANTS.MIN_DUELS_FOR_THETA) {
    out.push({
      kind: 'thin_evidence',
      claim:
        'There is not enough evidence here to separate you from the average person on file, so most of this is the population wearing your name.',
      anchor: 'not enough',
      strength: 100,
    });
  }

  // 2. An axis with no positive rating in either window, pushed away in duels.
  const heldBefore = new Set(regionBefore.frontierAxes);
  for (const key of regionAfter.frontierAxes) {
    if (!heldBefore.has(key)) continue;
    const t = theta[AXIS_KEYS.indexOf(key)] ?? 0;
    if (t >= 0) continue;
    const meta = axisMeta(key);
    out.push({
      kind: 'refused_axis',
      claim: `You have never once rated anything positively on ${meta.label}, and you turn it down in duels as well, so that part of the map is still closed.`,
      anchor: meta.label,
      strength: 20 + Math.abs(t),
      axis: key,
    });
  }

  // 3. The region did not move, or it never covered much ground.
  const ratio = Math.exp(regionAfter.volume - regionBefore.volume);
  if (Number.isFinite(ratio) && ratio <= 1.02) {
    out.push({
      kind: 'narrow_region',
      claim:
        'The region you actually enjoy has stayed narrow since the last read, which is a result about effort rather than about taste.',
      anchor: 'narrow',
      strength: 25,
    });
  } else if (regionAfter.exploredAxes.length <= 3) {
    out.push({
      kind: 'narrow_region',
      claim:
        'You keep returning to a narrow slice of the map, and almost everything you have tried sits inside it.',
      anchor: 'narrow',
      strength: 18,
    });
  }

  // 4. Ratings that never discriminate carry no information, which makes the
  //    logs decorative. Users hate hearing this and it is usually true.
  const rated = logs.filter((l) => Number.isFinite(l.rating));
  if (rated.length >= 6) {
    const mean = rated.reduce((s, l) => s + l.rating, 0) / rated.length;
    const min = Math.min(...rated.map((l) => l.rating));
    if (mean >= 4.3 && min >= 4) {
      out.push({
        kind: 'undiscriminating',
        claim:
          'You rate nearly everything you log at the top of the scale, which makes your ratings close to useless as evidence about you.',
        anchor: 'nearly everything',
        strength: 22,
      });
    }
  }

  // 5. Last resort, and it always fires for anyone with an opinion: name the
  //    axis they push away hardest.
  let worstIdx = -1;
  let worst = 0;
  let best = 0;
  for (let i = 0; i < AXIS_COUNT; i++) {
    if (theta[i] < worst) {
      worst = theta[i];
      worstIdx = i;
    }
    if (theta[i] > best) best = theta[i];
  }
  if (worstIdx >= 0) {
    const meta = axisMeta(AXIS_KEYS[worstIdx]);
    const claim =
      Math.abs(worst) > best
        ? `Your loudest opinion is a refusal rather than an appetite: you push away ${meta.label} harder than you pull toward anything.`
        : `There is nothing surprising in how you handle ${meta.label}, because you avoid it every time, and it is the easiest thing about you to predict.`;
    out.push({
      kind: 'strong_rejection',
      claim,
      anchor: meta.label,
      strength: 8 + Math.abs(worst),
      axis: meta.key as AxisKey,
    });
  }

  // 6. Absolute floor. A user with a flat theta, no logs and no frontier still
  //    gets a true criticism, because the alternative is a portrait that only
  //    compliments and there is no such thing as an acceptable one.
  if (out.length === 0) {
    out.push({
      kind: 'thin_evidence',
      claim:
        'There is not enough here to distinguish your palate from anyone else on file, and nothing you have done so far has changed that.',
      anchor: 'not enough',
      strength: 1,
    });
  }

  const kindOrder: UnflatteringKind[] = [
    'thin_evidence',
    'narrow_region',
    'undiscriminating',
    'refused_axis',
    'strong_rejection',
  ];
  return out.sort(
    (a, b) =>
      b.strength - a.strength ||
      kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) ||
      (a.axis ?? '').localeCompare(b.axis ?? ''),
  );
}

/**
 * Build the packet. Guarantees: every field is derived from the input, there is
 * always exactly one unflattering claim, and no number reaches the renderer.
 */
export function derivePortraitPacket(input: PortraitInput): PortraitPacket {
  const signature = signatureAxes(input.user.theta);
  const unflattering = deriveUnflatteringCandidates(input)[0];
  let volume = describeVolumeChange(input.regionBefore, input.regionAfter, input.user.theta);

  // Do not spend both the criticism and the volume line on the same axis when
  // the frontier has another one to name. Two sentences about one axis reads
  // like the model only found one thing.
  if (unflattering.axis && volume.refusedAxis === unflattering.axis) {
    const alt = input.regionAfter.frontierAxes.filter((k) => k !== unflattering.axis);
    if (alt.length > 0) {
      const next = pickRefusedAxis(
        input.regionBefore,
        { ...input.regionAfter, frontierAxes: alt },
        input.user.theta,
      );
      volume = {
        ...volume,
        refusedAxis: next,
        refusedLabel: next ? axisMeta(next).label : null,
      };
    }
  }

  const byRating = [...input.logs]
    .filter((l) => speakable(l.dishName))
    .sort((a, b) => b.rating - a.rating || a.dishName.localeCompare(b.dishName));

  const favoriteDishes = unique(byRating.filter((l) => l.rating >= 4).map((l) => l.dishName)).slice(
    0,
    3,
  );
  const dislikedDishes = unique(
    byRating
      .filter((l) => l.rating <= 2)
      .reverse()
      .map((l) => l.dishName),
  ).slice(0, 2);

  const allowedLabels = unique([
    ...signature.map((s) => s.label),
    ...(volume.refusedLabel ? [volume.refusedLabel] : []),
    ...(unflattering.axis ? [axisMeta(unflattering.axis).label] : []),
  ]);

  return {
    signature,
    favoriteDishes,
    dislikedDishes,
    unflattering,
    volume,
    allowedLabels,
    thetaStable:
      input.user.nComparisons >= CONSTANTS.MIN_DUELS_FOR_THETA &&
      input.user.posteriorVar <= CONSTANTS.THETA_STABLE_VAR,
  };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Words that make a sentence land as a criticism. This list is the weakest of
 * the four defences and it is only load-bearing against a model that keeps the
 * anchor phrase and inverts the polarity around it. The strong defences are
 * that the claim came from the data and that it lands in a known field.
 */
const NEGATIVE_MARKERS = [
  'not', "won't", "don't", "doesn't", "haven't", "isn't", "can't",
  'never', 'no', 'nothing', 'refuse', 'refusal', 'reject', 'avoid',
  'avoids', 'narrow', 'narrowed', 'rarely', 'seldom', 'hardly', 'closed', 'stuck',
  'limited', 'useless', 'predictable', 'predict', 'ignore', 'miss', 'misses',
  'missing', 'wasted', 'blind spot', 'unwilling', 'will not', 'cannot', 'stopped',
  'costs', 'at the expense of', 'repetitive', 'flat', 'least',
];

/**
 * Praise that survives an anchor check. "You are not afraid of bitterness"
 * carries a negative marker and is still a compliment, so the polarity test
 * needs a second half.
 */
const PRAISE_MARKERS = [
  'not afraid', 'unafraid', 'fearless', 'wonderful', 'impressive', 'admirable',
  'enviable', 'commendable', 'to your credit', 'a strength', 'refreshing',
  'well done', 'rare gift', 'nothing wrong', 'no shame', 'no bad',
];

/** Enthusiasm is banned in every generated string this product produces. */
const ENTHUSIASM_PHRASES = [
  "you'll love", 'you will love', 'amazing', 'incredible', 'delicious', 'must try',
  'must-try', 'obsessed', 'perfect for you', 'trust me', 'absolutely', 'so good',
  'the best', 'crave', 'craving', 'stunning', 'gorgeous', 'irresistible',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'i').test(text);
}

/**
 * Emoji detection by code point range rather than a unicode property escape,
 * which this tsconfig target cannot compile.
 */
function hasEmoji(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x1f000 && cp <= 0x1faff) return true;
    if (cp >= 0x2600 && cp <= 0x27bf) return true;
    if (cp >= 0x2b00 && cp <= 0x2bff) return true;
    if (cp === 0xfe0f || cp === 0x2764) return true;
  }
  return false;
}

function sentenceCount(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * True when this sentence reads as the criticism we derived.
 *
 * Three conditions, all required: it carries the anchor phrase we pinned to the
 * claim, it carries at least one negative marker, and it carries no praise
 * marker that would invert it.
 */
export function verifyUnflattering(sentence: string, claim: UnflatteringClaim): boolean {
  if (!containsPhrase(sentence, claim.anchor)) return false;
  if (PRAISE_MARKERS.some((p) => containsPhrase(sentence, p))) return false;
  return NEGATIVE_MARKERS.some((m) => containsPhrase(sentence, m));
}

/** Join the fields into the body. The order is fixed so the check is positional. */
export function composeBody(draft: PortraitDraft): string {
  return [draft.opening, draft.unflattering, draft.volume]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/**
 * Every rule violation in a draft. Empty array means the draft may ship.
 *
 * Returned as a list rather than a boolean so the retry can tell the model what
 * it broke, and so a hard failure names the reason in the thrown error.
 */
export function findViolations(draft: PortraitDraft, packet: PortraitPacket): string[] {
  const v: string[] = [];
  const body = composeBody(draft);

  if (draft.unflattering.trim().length === 0) v.push('unflattering field is empty');
  if (draft.opening.trim().length === 0) v.push('opening field is empty');
  if (draft.volume.trim().length === 0) v.push('volume field is empty');

  // Rule 1. A digit anywhere is a number about a person.
  if (/\d/.test(body)) v.push('contains a digit');

  // Rule 6.
  if (body.includes('!')) v.push('contains an exclamation point');
  if (hasEmoji(body)) v.push('contains emoji');
  for (const p of ENTHUSIASM_PHRASES) {
    if (containsPhrase(body, p)) v.push(`enthusiasm marker: ${p}`);
  }

  if (sentenceCount(body) > MAX_SENTENCES) v.push('longer than five sentences');

  // Rule 2. An axis name we did not put in the packet was not grounded in
  // anything, which means the model decided it rather than reported it.
  //
  // Dish names are removed before the scan. A dish legitimately called "Crunch
  // Roll" is evidence we handed over, and flagging it as an ungrounded mention
  // of the crunch axis would reject a correct portrait.
  const allowed = new Set(packet.allowedLabels.map((l) => l.toLowerCase()));
  let scannable = body;
  for (const dish of [...packet.favoriteDishes, ...packet.dislikedDishes]) {
    scannable = scannable.split(dish).join(' ');
  }
  for (const axis of AXES) {
    if (allowed.has(axis.label.toLowerCase())) continue;
    if (containsPhrase(scannable, axis.label)) v.push(`ungrounded axis name: ${axis.label}`);
  }

  // The horoscope check.
  if (!verifyUnflattering(draft.unflattering, packet.unflattering)) {
    v.push(
      `unflattering sentence does not carry the derived claim (needs the phrase "${packet.unflattering.anchor}" stated as a criticism)`,
    );
  }

  // The volume line has to actually report the movement and the refusal.
  if (!draft.volume.toLowerCase().includes(packet.volume.phrase.toLowerCase())) {
    v.push(`volume sentence is missing the phrase "${packet.volume.phrase}"`);
  }
  if (packet.volume.refusedLabel && !containsPhrase(draft.volume, packet.volume.refusedLabel)) {
    v.push(`volume sentence does not name the refused axis "${packet.volume.refusedLabel}"`);
  }

  return v;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function axisLine(s: PortraitPacket['signature'][number]): string {
  return `- ${s.label}: they sit at "${s.pole}", and this opinion is ${s.strength}`;
}

/**
 * The rules are bulleted rather than numbered on purpose. Nothing the model
 * receives, prompt or evidence, contains a digit, so a digit in the output is
 * provably invention rather than something it read here and echoed back.
 */
function systemPrompt(packet: PortraitPacket): string {
  const labels = packet.allowedLabels.map((l) => `"${l}"`).join(', ');
  return `You write a palate portrait: a short, dry piece of writing about one person's taste, built only from the evidence you are given.

VOICE
Second person. Specific and unsentimental, the way one cook describes another
cook's palate rather than the way an app describes a user. Never warm, never
congratulatory, never knowing. Short sentences.

HARD RULES
- Every claim must come from the evidence. No invented dishes, no invented
  cuisines, no invented habits, no guesses about who this person is.
- No digits anywhere. No percentages, no counts, no ratings, no scores. If you
  need to say how much something changed, use the exact words you were given.
- No exclamation points, no emoji, no "you'll love", no compliment used as
  filler or as a cushion. Do not call them adventurous, interesting or bold.
- The only axis names you may write are: ${labels}. Do not name any other axis.
- Do not balance the criticism. Do not follow it with something nice.

OUTPUT
Return only JSON, no prose and no markdown fence:
{"opening": "...", "unflattering": "...", "volume": "..."}

opening: one or two sentences on what defines their palate, naming one dish they
actually rated highly if you were given one.

unflattering: exactly one sentence. Restate this claim in your own words:
"${packet.unflattering.claim}"
It must contain the exact phrase "${packet.unflattering.anchor}". It must read as
a criticism the person will not enjoy. Do not soften it.

volume: exactly one sentence about how the region they enjoy has changed. It must
contain the exact phrase "${packet.volume.phrase}"${
    packet.volume.refusedLabel
      ? `, and it must name "${packet.volume.refusedLabel}" as the thing they still will not go near`
      : ''
  }.`;
}

/**
 * What actually goes over the wire. Strips the internal strength score and the
 * axis keys, so the payload provably contains no number about this person.
 */
function promptPayload(packet: PortraitPacket): string {
  const lines = [
    'Their palate:',
    ...(packet.signature.length > 0
      ? packet.signature.map(axisLine)
      : ['- no axis is strong enough to name yet']),
    '',
    packet.favoriteDishes.length > 0
      ? `Dishes they rated highly: ${packet.favoriteDishes.join(', ')}`
      : 'They have not rated anything highly yet.',
    packet.dislikedDishes.length > 0
      ? `Dishes they rated poorly: ${packet.dislikedDishes.join(', ')}`
      : 'They have not rated anything poorly yet.',
    '',
    `How the region they enjoy has changed: it ${packet.volume.phrase}.`,
    packet.volume.refusedLabel
      ? `The axis they still refuse: ${packet.volume.refusedLabel}.`
      : 'There is no axis left that they have refused outright.',
    '',
    `The true thing they will not enjoy reading: ${packet.unflattering.claim}`,
  ];
  return lines.join('\n');
}

function parseDraft(text: string): PortraitDraft {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Portrait returned unparseable JSON: ${cleaned.slice(0, 200)}`);
  }
  const o = parsed as Partial<PortraitDraft>;
  return {
    opening: typeof o.opening === 'string' ? o.opening : '',
    unflattering: typeof o.unflattering === 'string' ? o.unflattering : '',
    volume: typeof o.volume === 'string' ? o.volume : '',
  };
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Routed through Merge Gateway when configured; see core/anthropic-client.ts.
  if (!client) client = new Anthropic(anthropicClientOptions());
  return client;
}

const apiDraft: DraftGenerator = async (packet, _attempt, priorViolations) => {
  const retryNote =
    priorViolations.length > 0
      ? `\n\nYour previous attempt was rejected for: ${priorViolations.join('; ')}. Fix every one of these.`
      : '';

  const res = await anthropic().messages.create({
    model: RENDER_MODEL,
    max_tokens: 1000,
    system: systemPrompt(packet),
    messages: [{ role: 'user', content: promptPayload(packet) + retryNote }],
    // Temperature is left at the default and the attempt index does not change
    // sampling. A retry should succeed because the model was told what it broke,
    // not because it got luckier.
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseDraft(text);
};

/**
 * Deterministic stand-in for the model, used when there is no key.
 *
 * This is not a production path and must never become one: the whole point of
 * the portrait is that it is written rather than assembled. It exists so the
 * verification, the volume line and every downstream surface are testable and
 * demoable before a key lands.
 */
export const dryRunDraft: DraftGenerator = (packet) => {
  const clause = (s: PortraitPacket['signature'][number]) =>
    s.direction === 'high'
      ? `you want ${s.label} loud`
      : `you keep ${s.label} out of the dish`;

  // The criticism already spends a sentence on its own axis, so the opening
  // uses a different one where the signature has one to spare.
  const spare = packet.signature.filter((s) => s.axis !== packet.unflattering.axis);
  const [first, second] = spare.length > 0 ? spare : packet.signature;

  let opening = first
    ? `${clause(first)[0].toUpperCase()}${clause(first).slice(1)}${
        second ? `, and ${clause(second)}` : ''
      }.`
    : 'Nothing about your palate is loud enough to lead with yet.';
  if (packet.favoriteDishes.length > 0) {
    opening += ` The ${packet.favoriteDishes[0]} was not an accident.`;
  }

  const volume = packet.volume.refusedLabel
    ? `The region you enjoy ${packet.volume.phrase}, and you still will not go near ${packet.volume.refusedLabel}.`
    : `The region you enjoy ${packet.volume.phrase}, and there is no axis left that you refuse outright.`;

  return { opening, unflattering: packet.unflattering.claim, volume };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a palate portrait.
 *
 * Guarantees, all enforced on our side rather than trusted from the model:
 * - The body contains no digit, no exclamation point, no emoji and no
 *   enthusiasm marker.
 * - The body names no axis that was not in the packet.
 * - The body contains one sentence that restates a criticism DERIVED FROM THE
 *   DATA, so containsUnflattering is true by verification and never otherwise.
 * - The body says how much the enjoyed region moved and which axis is still
 *   refused, in words rather than figures.
 *
 * Throws after the retries are exhausted. A portrait that only compliments is a
 * horoscope, and returning one quietly would be worse than returning nothing.
 */
export async function generatePalatePortrait(
  input: PortraitInput,
  options: PortraitOptions = {},
): Promise<PalatePortrait> {
  const packet = derivePortraitPacket(input);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const generate = options.draft ?? (dryRunEnabled() ? dryRunDraft : apiDraft);

  let violations: string[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const draft = await generate(packet, attempt, violations);
    violations = findViolations(draft, packet);
    if (violations.length === 0) {
      return {
        userId: input.userId,
        body: composeBody(draft),
        containsUnflattering: true,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  throw new Error(
    `Portrait failed verification after ${maxAttempts} attempts: ${violations.join('; ')}`,
  );
}

export const __testing = {
  systemPrompt,
  promptPayload,
  parseDraft,
  sentenceCount,
  hasEmoji,
  containsPhrase,
  signatureAxes,
  pickRefusedAxis,
  NEGATIVE_MARKERS,
  PRAISE_MARKERS,
  ENTHUSIASM_PHRASES,
  MAX_SENTENCES,
};
