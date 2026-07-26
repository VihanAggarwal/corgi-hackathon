/**
 * Menu photo to order. Track C.
 *
 * A photograph of a menu we have never seen, taken in a dark restaurant, in.
 * One grounded recommendation, or an honest refusal, out.
 *
 * WHY THIS PATH EXISTS
 * Every other surface needs corpus coverage. This one needs none: the menu in
 * the photo IS the candidate set. That makes it the only feature that works in
 * a restaurant nobody has ever entered, and it is also the feature with the
 * shortest distance between a model mistake and a person ordering the wrong
 * plate. Everything below is arranged around that second fact.
 *
 * THE PIPELINE, AND WHY IT IS IN THIS ORDER
 *
 *   1. vision read      photo to dish names, descriptions, prices
 *   2. constraint filter set intersection, BEFORE any further model call
 *   3. phi extraction   Track A's extractor, unchanged, on the survivors
 *   4. readability      can we read the axes THIS user actually orders on
 *   5. rank             Track A's frontier ranker against theta
 *   6. packet           Track A's buildEvidencePacket, the privacy boundary
 *   7. render           Track A's renderRecommendation, validated
 *
 * Step 2 sits where it does because of hard rule 3: constraint values are
 * applied as a set intersection before a model sees the candidate list, and the
 * only thing that survives the step is an integer. Step 1 is above it because a
 * photograph is not constraint data, and there is nothing to intersect until
 * the menu has been read.
 *
 * WHAT THIS FILE DOES NOT DO
 * It does not extract phi, rank, build packets, or generate text. Those are
 * Track A's, imported. A second extraction prompt living here would drift from
 * the corpus one within a day and every dish read from a photo would then be
 * scored on a slightly different scale from every dish in the database, which
 * is a bug nobody would ever see.
 *
 * NO KEY, STILL DEMOABLE
 * With no credentials the read degrades to a deterministic stub and the
 * renderer to its template path, so the route answers today. The stub says it
 * is a stub, in the response and in the reply text, because a fabricated menu
 * presented as a real read is the exact failure this file is built to avoid.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AXES, AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../../contracts/axes';
import { CONSTANTS, type Conf24, type Vec24 } from '../../contracts/types';
import {
  anthropicClientOptions,
  buildEvidencePacket,
  computeRegion,
  expansionForPacket,
  hasModelCredentials,
  rankFrontier,
  renderRecommendation,
  type FrontierCandidate,
  type RatedDish,
  type RenderOptions,
} from '../../core';
import { applyConstraintRows, type ConstraintRow } from '../../lib/db';
// Types only. The runtime import is deliberately lazy; see loadCorpusExtractor.
import type { ExtractionResult, MenuItem } from '../../scripts/corpus/extract';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Reading a menu in bad light is the hardest thing we ask a model to do. */
const VISION_MODEL = 'claude-opus-5';

/** One read plus one repair. A third attempt on the same photo reads the same. */
const MAX_READ_ATTEMPTS = 2;

/** Anthropic's per-image ceiling. Enforced here so the failure is ours, not theirs. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Menu lines carried past the read. A photograph of a two-page menu can hold a
 * hundred lines, and extraction cost is linear in that number while the value
 * of ranking the eightieth candidate is zero.
 */
const MAX_ITEMS = 60;

/**
 * An axis is one this user orders on when their theta is at least this far from
 * the population mean, in z units. Below it the axis contributes so little to
 * theta . phi that failing to read it changes no ranking, so hedging about it
 * would be theatre.
 */
const DRIVING_AXIS_FLOOR = 0.35;

/** More than this and the "axes that matter for you" claim stops being specific. */
const MAX_DRIVING_AXES = 6;

/**
 * Share of the user's driving-axis weight that the extraction must actually
 * have measured before we will speak about a dish with confidence.
 *
 * Half is not a compromise, it is the point at which the ranking is still
 * mostly evidence rather than mostly zeros: masked axes are zeroed by the
 * extractor, so an unread axis does not push a dish down, it makes the dish
 * invisible on that axis. Below half we are ranking on a minority of what we
 * know about the person.
 */
const CONFIDENT_COVERAGE = 0.5;

/** Above this we stop apologising for the photo. */
const WELL_READ_COVERAGE = 0.8;

/** Below this share of legible items, the menu itself gets a hedge, not just the dish. */
const WELL_READ_MENU_FRACTION = 0.5;

/** Default number of picks. Two is what "here are two I am confident about" means. */
const DEFAULT_MAX_PICKS = 2;

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

// ---------------------------------------------------------------------------
// Input and output types
// ---------------------------------------------------------------------------

export interface MenuPhoto {
  /** Base64 payload. A full `data:` URL is accepted and unwrapped. */
  base64: string;
  /** Read from the data URL when absent. Defaults to image/jpeg. */
  mediaType?: string;
}

/** One line the vision pass believes is a dish. */
export interface ReadMenuItem {
  name: string;
  description: string | null;
  priceCents: number | null;
  /** The model's own report of how clearly this line rendered, 0..1. */
  legibility: number;
}

export interface MenuRead {
  /** Only when printed on the menu itself. Never inferred. */
  venueName: string | null;
  items: ReadMenuItem[];
  /** Lines visible in the photo that could not be resolved into a dish. */
  unreadableLineCount: number;
  /** True when this came from the deterministic no-credentials path. */
  stub: boolean;
}

export type MenuPhotoErrorCode =
  | 'empty_image'
  | 'unsupported_media_type'
  | 'image_too_large'
  | 'unreadable_response';

/** Every failure this module raises on its way in. Carries a code, never a stack, to the caller. */
export class MenuPhotoError extends Error {
  readonly code: MenuPhotoErrorCode;
  constructor(code: MenuPhotoErrorCode, message: string) {
    super(message);
    this.name = 'MenuPhotoError';
    this.code = code;
  }
}

export interface MenuOrderInput {
  photo: MenuPhoto;
  /**
   * The reader's fitted preference vector. A zero vector is legal and means a
   * cold-start user: ranking still works, no axis is claimed to have driven it.
   */
  theta?: Vec24;
  nComparisons?: number;
  posteriorVar?: number;
  /** Printed on the menu, or supplied by the caller. Falls back to a neutral phrase. */
  venueName?: string;
  neighborhood?: string;
  /** Rated history, used only to place the frontier. Absent means no expansion claim. */
  logs?: RatedDish[];
  /**
   * Whose constraints to apply. Values are fetched, intersected, and dropped
   * inside the filter; nothing about them reaches this function's return value
   * except a count.
   */
  userId?: string;
}

export interface MenuOrderOptions {
  /** Injectable vision seam. Defaults to the Anthropic call, or the stub with no key. */
  read?: (photo: MenuPhoto) => Promise<MenuRead>;
  /** Injectable extraction seam. Defaults to Track A's corpus extractor. */
  extract?: (items: MenuItem[]) => Promise<ExtractionResult[]>;
  /** Passed to Track A's renderer. Used by tests to force the dry path or a bad model. */
  render?: RenderOptions;
  /** Constraint rows the caller already holds, for the enterprise and test paths. */
  constraintRows?: readonly ConstraintRow[];
  maxPicks?: number;
}

export interface MenuPick {
  dishName: string;
  priceCents: number | null;
  /** Validated against the packet by Track A's renderer before it gets here. */
  text: string;
  packetId: string;
  confidence: 'high' | 'medium' | 'low';
}

export type MenuOrderStatus = 'ok' | 'partial' | 'unreadable' | 'degraded';

export interface MenuOrderResult {
  status: MenuOrderStatus;
  /**
   * The honesty line, or null when there is nothing to hedge. Templated from
   * counts rather than generated, because a model asked to describe its own
   * uncertainty will describe it beautifully and inaccurately.
   */
  preface: string | null;
  picks: MenuPick[];
  read: {
    /** Dish lines the photo yielded. A number about a menu, not about a person. */
    itemsSeen: number;
    /** How many of those we can judge for this reader. */
    itemsReadable: number;
    unreadableLineCount: number;
    stub: boolean;
  };
  /** Hard rule 3. A count. Never which, never whose. */
  constraintsAppliedCount: number;
}

// ---------------------------------------------------------------------------
// Photo normalization
// ---------------------------------------------------------------------------

const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+)?(?:;charset=[^;,]+)?;base64,/i;

function isSupportedMediaType(v: string): v is SupportedMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(v);
}

/**
 * Decoded byte length of a base64 string, without decoding it.
 *
 * Decoding to measure would allocate the whole image before we are willing to
 * accept it, which is the shape of the denial-of-service the size cap exists
 * to prevent.
 */
function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/**
 * Accept a data URL or a bare base64 payload and produce something the vision
 * API will take.
 *
 * Guarantees: the returned media type is one the model actually supports, the
 * payload is non-empty base64 within the per-image size limit, and every
 * rejection is a MenuPhotoError carrying a stable code rather than a throw from
 * inside the SDK.
 */
export function normalizePhoto(photo: MenuPhoto): { base64: string; mediaType: SupportedMediaType } {
  const raw = (photo?.base64 ?? '').trim();
  if (raw.length === 0) throw new MenuPhotoError('empty_image', 'No image data was supplied.');

  let payload = raw;
  let mediaType = (photo.mediaType ?? '').trim().toLowerCase();

  const match = DATA_URL_RE.exec(raw);
  if (match) {
    payload = raw.slice(match[0].length);
    // An explicit mediaType wins: the caller knows what it read off the file,
    // and browsers write "application/octet-stream" into data URLs often enough
    // that trusting the prefix rejects real photographs.
    if (mediaType.length === 0 && match[1]) mediaType = match[1].toLowerCase();
  }

  payload = payload.replace(/\s+/g, '');
  if (payload.length === 0) throw new MenuPhotoError('empty_image', 'No image data was supplied.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new MenuPhotoError('empty_image', 'The image payload is not base64.');
  }

  if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
  if (mediaType.length === 0) mediaType = 'image/jpeg';
  if (!isSupportedMediaType(mediaType)) {
    throw new MenuPhotoError(
      'unsupported_media_type',
      `Image type ${mediaType} is not supported. Use JPEG, PNG, WebP, or GIF.`,
    );
  }

  if (base64Bytes(payload) > MAX_IMAGE_BYTES) {
    throw new MenuPhotoError(
      'image_too_large',
      `The image is over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB. Send a smaller photo.`,
    );
  }

  return { base64: payload, mediaType };
}

// ---------------------------------------------------------------------------
// The vision read
// ---------------------------------------------------------------------------

/**
 * Transcription, not interpretation.
 *
 * The prompt asks for nothing but what is printed, and makes counting an
 * unreadable line the cheap answer. A model that guesses at a blurred line
 * produces a dish that does not exist on that menu, and the person is standing
 * in the restaurant holding the real one.
 */
const READ_SYSTEM_PROMPT = `You transcribe photographs of restaurant menus. You do not interpret them and
you do not describe food.

RETURN ONLY WHAT IS PRINTED.
Every dish name, description, and price you return must be visible in the
image. Do not complete a partially visible word. Do not supply a description
the menu does not print. Do not add a dish that a restaurant of this kind
usually serves. If you cannot read it, it does not exist.

UNREADABLE LINES ARE THE EXPECTED CASE.
Menus are photographed in dark rooms at an angle. When you can see that a line
is there but cannot read it well enough to transcribe it, do not guess: add one
to "unreadable_lines" and move on. A high unreadable count is a correct answer.
You are scored on whether every returned line is really on that menu, not on
how many lines you returned.

LEGIBILITY.
Give each returned item a legibility from 0 to 1 describing how clearly that
line rendered in the photo.
- 1.0  crisp, no doubt about any character
- 0.6  readable, some characters inferred from context
- 0.3  you can make out the words but would not bet on the spelling

WHAT IS NOT A DISH.
Section headers ("APPETIZERS"), drinks, allergen notices, opening hours, and
the restaurant's address are not dishes. Leave them out and do not count them
as unreadable lines.

PRICES.
Only when printed and legible. Return whole cents as an integer, so $14 is
1400. Never convert a currency and never estimate.

VENUE NAME.
Only if the restaurant's name is printed on the menu itself. Otherwise null.

OUTPUT.
Return only JSON, no prose and no markdown fence:
{"venue_name": string|null, "unreadable_lines": integer,
 "items": [{"name": string, "description": string|null,
            "price_cents": integer|null, "legibility": number}]}`;

const READ_USER_PROMPT =
  'Transcribe this menu. Return the JSON object and nothing else.';

interface RawRead {
  venue_name?: unknown;
  unreadable_lines?: unknown;
  items?: unknown;
}

function asFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Coerce a vision response into a MenuRead.
 *
 * Anything structurally wrong about one item drops that item rather than the
 * whole read, and an item that drops is counted as unreadable rather than
 * forgotten. Losing a line silently is how a menu of eleven dishes reports as a
 * menu of four and nobody notices the photo was bad.
 */
export function parseRead(text: string): MenuRead {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new MenuPhotoError('unreadable_response', 'The menu read did not return JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MenuPhotoError('unreadable_response', 'The menu read did not return an object.');
  }

  const raw = parsed as RawRead;
  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  const items: ReadMenuItem[] = [];
  let dropped = 0;

  for (const entry of rawItems) {
    if (entry === null || typeof entry !== 'object') {
      dropped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (name.length === 0) {
      dropped += 1;
      continue;
    }
    if (items.length >= MAX_ITEMS) {
      // Over the cap the line is real but unconsidered, and saying so is more
      // honest than pretending the menu ended.
      dropped += 1;
      continue;
    }

    const description = typeof e.description === 'string' && e.description.trim().length > 0
      ? e.description.trim()
      : null;
    const price = asFiniteNumber(e.price_cents);
    const legibility = asFiniteNumber(e.legibility);

    items.push({
      name,
      description,
      // A negative or absurd price is a misread, not a bargain.
      priceCents: price != null && price > 0 && price < 1_000_000 ? Math.round(price) : null,
      // No stated legibility means we do not know it rendered well, and the
      // optimistic default is the one that produces a confident wrong answer.
      legibility: legibility == null ? 0.5 : clamp(legibility, 0, 1),
    });
  }

  const stated = asFiniteNumber(raw.unreadable_lines);
  const unreadableLineCount = Math.max(0, Math.round(stated ?? 0)) + dropped;
  const venueName = typeof raw.venue_name === 'string' && raw.venue_name.trim().length > 0
    ? raw.venue_name.trim()
    : null;

  return { venueName, items, unreadableLineCount, stub: false };
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Routed through Merge Gateway when configured, same accessor shape as
  // core/render.ts. See docs/TRACK-C-MERGE-BRIEF.md.
  if (!client) client = new Anthropic(anthropicClientOptions());
  return client;
}

/** Reset the cached client. Tests and key rotation only. */
export function resetVisionClient(): void {
  client = null;
}

/**
 * A menu the stub path can serve, chosen deterministically from the photo.
 *
 * Deliberately mundane and deliberately uneven: two lines carry no description
 * at all, so the readability check downstream has something real to fail on
 * rather than a synthetic menu where everything reads perfectly.
 */
const STUB_MENUS: ReadonlyArray<{ venueName: string; items: ReadMenuItem[]; unreadable: number }> = [
  {
    venueName: 'Sample Menu One',
    items: [
      { name: 'Cold Sesame Noodles', description: 'chilled wheat noodles, sesame paste, cucumber', priceCents: 1200, legibility: 0.9 },
      { name: 'Cumin Lamb Skewers', description: 'charred over coals, heavy cumin and chili', priceCents: 1600, legibility: 0.85 },
      { name: 'House Salad', description: null, priceCents: 900, legibility: 0.4 },
      { name: 'Pork and Chive Dumplings', description: 'steamed, twelve pieces, black vinegar', priceCents: 1400, legibility: 0.8 },
      { name: 'Daily Vegetable', description: null, priceCents: null, legibility: 0.3 },
    ],
    unreadable: 3,
  },
  {
    venueName: 'Sample Menu Two',
    items: [
      { name: 'Anchovy Toast', description: 'cultured butter, salted anchovy, grilled sourdough', priceCents: 1100, legibility: 0.9 },
      { name: 'Bitter Greens', description: 'radicchio and escarole, sharp mustard dressing', priceCents: 1300, legibility: 0.75 },
      { name: 'Braised Short Rib', description: 'red wine, four hours, soft polenta', priceCents: 3200, legibility: 0.9 },
      { name: 'Soft Serve', description: null, priceCents: 700, legibility: 0.5 },
    ],
    unreadable: 2,
  },
];

/** FNV-1a, same as the corpus pipeline, so a photo picks the same stub anywhere. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The no-credentials read.
 *
 * Returns a real MenuRead shape so every stage downstream is exercised, and
 * sets `stub` so no caller can mistake it for the photograph. The reply that
 * comes out of the pipeline says it is a stub in its first sentence.
 */
export function stubRead(photo: { base64: string }): MenuRead {
  const menu = STUB_MENUS[hash(photo.base64.slice(0, 512)) % STUB_MENUS.length];
  return {
    venueName: menu.venueName,
    items: menu.items.map((i) => ({ ...i })),
    unreadableLineCount: menu.unreadable,
    stub: true,
  };
}

/**
 * Read a menu photograph into dish lines.
 *
 * Guarantees: never returns an invented dish that the model did not claim to
 * see, never throws anything but MenuPhotoError, and makes at most
 * MAX_READ_ATTEMPTS model calls. With no model credentials it makes zero
 * network calls and returns a read marked `stub`.
 */
export async function readMenuPhoto(photo: MenuPhoto): Promise<MenuRead> {
  const { base64, mediaType } = normalizePhoto(photo);

  if (!hasModelCredentials()) return stubRead({ base64 });

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: READ_USER_PROMPT },
      ],
    },
  ];

  let lastError: MenuPhotoError | null = null;

  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
    let text: string;
    try {
      const res = await anthropic().messages.create({
        model: VISION_MODEL,
        max_tokens: 4000,
        system: READ_SYSTEM_PROMPT,
        messages,
      });
      text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch {
      // Transport, rate limit, or a model refusal. The provider's message is
      // not something we hand to a person standing in a restaurant, and it can
      // carry request metadata, so it is dropped rather than wrapped.
      lastError = new MenuPhotoError('unreadable_response', 'The menu read did not complete.');
      continue;
    }

    try {
      return parseRead(text);
    } catch (err) {
      lastError = err instanceof MenuPhotoError
        ? err
        : new MenuPhotoError('unreadable_response', 'The menu read did not parse.');
      // Feed the failure back once. A bare retry returns the same malformed
      // shape, because the photo has not changed and neither has the prompt.
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({
        role: 'user',
        content:
          'That was not the JSON object described. Return only the object, with the keys ' +
          'venue_name, unreadable_lines, and items. Transcribe nothing new.',
      });
    }
  }

  throw lastError ?? new MenuPhotoError('unreadable_response', 'The menu read did not complete.');
}

// ---------------------------------------------------------------------------
// Extraction, borrowed whole from Track A
// ---------------------------------------------------------------------------

interface LoadedExtractor {
  extractBatch: (items: MenuItem[]) => Promise<ExtractionResult[]>;
  toDishVector: (r: ExtractionResult) => { phi: Vec24; confidence: Conf24; maskedAxes: AxisKey[] };
  /**
   * True when the corpus pipeline is in dry run, which means the phi vectors
   * are synthetic. Carried out of here because a synthetic vector under a real
   * photograph is a confident recommendation grounded in nothing.
   */
  synthetic: boolean;
}

/**
 * Load Track A's extractor lazily.
 *
 * The import is dynamic rather than static for two reasons, both of which are
 * reported to Track A rather than worked around here. scripts/corpus/config.ts
 * calls dotenv at module scope, and dotenv is a devDependency, so a static
 * import puts a script's environment loading into the request path of the Next
 * app. And its DRY_RUN is computed once at import time from, among other
 * things, GOOGLE_PLACES_API_KEY, which has nothing to do with whether a dish
 * description can be read. A lazy import keeps both of those out of the module
 * graph until the extractor is genuinely needed, and lets a failed import
 * degrade to abstention instead of a 500.
 */
async function loadCorpusExtractor(): Promise<LoadedExtractor | null> {
  try {
    const [extract, config] = await Promise.all([
      import('../../scripts/corpus/extract'),
      import('../../scripts/corpus/config'),
    ]);
    return {
      extractBatch: extract.extractBatch,
      toDishVector: extract.toDishVector,
      synthetic: config.DRY_RUN,
    };
  } catch {
    return null;
  }
}

function menuItemsFor(read: MenuRead, venueKey: string): MenuItem[] {
  return read.items.map((item) => ({
    key: `${venueKey}::${item.name}`,
    venueKey,
    name: item.name,
    description: item.description,
    priceCents: item.priceCents,
    // No cuisine hint on purpose. We have never seen this venue, and Track A's
    // prompt is explicit that cuisine is not a substitute for evidence.
    venueCuisine: null,
  }));
}

/** Fully abstained vectors. Used when the extractor could not be loaded at all. */
function abstained(items: MenuItem[]): ExtractionResult[] {
  return items.map((it) => ({
    key: it.key,
    phi: new Array(AXIS_COUNT).fill(0),
    confidence: new Array(AXIS_COUNT).fill(0),
    maskedAxes: [...AXIS_KEYS],
    abstainedEntirely: true,
  }));
}

// ---------------------------------------------------------------------------
// Readability: can we read the axes that matter to THIS reader
// ---------------------------------------------------------------------------

export interface ReadabilityAssessment {
  /** Vector indices this reader's ordering actually turns on. */
  drivingAxes: number[];
  /**
   * Per-dish share of the reader's driving-axis weight that the extraction
   * measured, 0..1, aligned with the dish array.
   *
   * INTERNAL ONLY. It is a number about how well we know one person, which is
   * exactly the shape hard rule 1 forbids leaving the system. It is used to
   * decide what to say and is never said.
   */
  coverage: number[];
  /** Indices of dishes we are willing to speak about for this reader. */
  readableIdx: number[];
  /** Driving axes no dish could be read on. These are what the hedge names. */
  unreadAxes: AxisKey[];
}

/**
 * The axes this reader orders on, strongest first.
 *
 * Magnitude, not sign: a person who refuses sweetness in savory food is as
 * driven by that axis as one who seeks it, and a menu that says nothing about
 * sweetness is equally unreadable for both.
 */
export function drivingAxes(theta: Vec24): number[] {
  const scored: Array<{ i: number; w: number }> = [];
  for (let i = 0; i < AXIS_COUNT; i++) {
    const v = theta[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (Math.abs(v) < DRIVING_AXIS_FLOOR) continue;
    scored.push({ i, w: Math.abs(v) });
  }
  scored.sort((a, b) => b.w - a.w || a.i - b.i);
  return scored.slice(0, MAX_DRIVING_AXES).map((s) => s.i);
}

/**
 * Judge how much of what matters to this reader the photo actually gave us.
 *
 * Guarantees: coverage is a finite number in 0..1 for every dish, a dish is
 * readable only when at least CONFIDENT_COVERAGE of the reader's driving-axis
 * weight cleared the extractor's confidence threshold, and a reader with no
 * driving axes is judged against all 24 axes equally rather than being declared
 * trivially readable.
 *
 * The weighting is by |theta|, not by axis count. A reader whose entire
 * ordering turns on chili heat is not half informed by a menu that reads
 * beautifully on twelve axes and says nothing about heat.
 */
export function assessReadability(
  theta: Vec24,
  dishes: Array<{ confidence: Conf24 }>,
): ReadabilityAssessment {
  const driving = drivingAxes(theta);

  // With no driving axes there is no such thing as "the axes that matter for
  // this reader", so the honest question becomes whether we read the dish at
  // all. Uniform weights over every axis answers exactly that.
  const indices = driving.length > 0 ? driving : [...Array(AXIS_COUNT).keys()];
  const weightOf = (i: number): number =>
    driving.length > 0 ? Math.abs(theta[i]) : 1;

  const totalWeight = indices.reduce((s, i) => s + weightOf(i), 0);

  const coverage: number[] = [];
  const readableIdx: number[] = [];
  const readCount = new Array(AXIS_COUNT).fill(0);

  dishes.forEach((dish, d) => {
    let covered = 0;
    for (const i of indices) {
      const c = dish.confidence?.[i];
      if (typeof c === 'number' && c >= CONSTANTS.CONF_THRESHOLD) {
        covered += weightOf(i);
        readCount[i] += 1;
      }
    }
    const share = totalWeight > 0 ? covered / totalWeight : 0;
    coverage.push(Number.isFinite(share) ? clamp(share, 0, 1) : 0);
    if (coverage[d] >= CONFIDENT_COVERAGE) readableIdx.push(d);
  });

  // An axis no dish on the menu could be read on is the specific thing to
  // apologise for, and it is the one the reader can verify by looking at the
  // menu themselves.
  const unreadAxes = driving
    .filter((i) => readCount[i] === 0)
    .map((i) => AXIS_KEYS[i]);

  return { drivingAxes: driving, coverage, readableIdx, unreadAxes };
}

function axisLabel(key: AxisKey): string {
  return AXES.find((a) => a.key === key)?.label ?? key;
}

/** "chili heat and richness", "chili heat, richness, and salt level". */
function joinLabels(keys: AxisKey[]): string {
  const labels = keys.map(axisLabel);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function spell(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** Neutral stand-in when the menu does not print a name and the caller has none. */
const UNNAMED_VENUE = 'this menu';

/**
 * The caveat that carries the photo's own limits into the generated sentence.
 *
 * Worded to survive the renderer's validator: no group noun, so it cannot read
 * as a claim about other diners, and no machinery vocabulary. It is the caveat
 * rather than a bolted-on hedge because caveats are mandatory in output, which
 * means the honesty ends up inside the recommendation instead of beside it.
 */
const PARTIAL_READ_CAVEAT = 'part of this menu did not read clearly in the photo';

interface Candidate {
  index: number;
  name: string;
  description: string | null;
  priceCents: number | null;
  phi: Vec24;
  confidence: Conf24;
  maskedAxes: AxisKey[];
}

function emptyResult(
  status: MenuOrderStatus,
  preface: string,
  read: MenuOrderResult['read'],
  constraintsAppliedCount: number,
): MenuOrderResult {
  return { status, preface, picks: [], read, constraintsAppliedCount };
}

/**
 * Turn a menu photograph into an order, or into an honest refusal.
 *
 * Guarantees:
 *  - Every dish named in a returned pick came from the photo. Text that names
 *    anything else is rejected by Track A's renderer and the pick is dropped,
 *    so a hallucinated dish produces one fewer recommendation, never a wrong one.
 *  - No recommendation is returned for a dish whose extraction did not cover at
 *    least CONFIDENT_COVERAGE of the reader's driving-axis weight. When nothing
 *    clears that bar the result says so and returns no picks.
 *  - Constraints are intersected out of the candidate list before the extractor
 *    or the renderer is called, and leave as `constraintsAppliedCount` only.
 *  - No number about a person appears in the result. Coverage, theta, and the
 *    frontier scores stay inside this function.
 *  - It does not throw for a bad photograph. Every failure below the request
 *    level is a status and a sentence.
 */
export async function menuPhotoToOrder(
  input: MenuOrderInput,
  options: MenuOrderOptions = {},
): Promise<MenuOrderResult> {
  const theta: Vec24 = normalizeTheta(input.theta);
  const maxPicks = Math.max(1, Math.min(5, options.maxPicks ?? DEFAULT_MAX_PICKS));

  const emptyRead = { itemsSeen: 0, itemsReadable: 0, unreadableLineCount: 0, stub: false };

  // 1. Read the photo.
  let read: MenuRead;
  try {
    read = await (options.read ?? readMenuPhoto)(input.photo);
  } catch (err) {
    const message = err instanceof MenuPhotoError
      ? err.message
      : 'The photo could not be read.';
    return emptyResult('degraded', `${message} Try a straighter shot with more light.`, emptyRead, 0);
  }

  const readSummary = {
    itemsSeen: read.items.length,
    itemsReadable: 0,
    unreadableLineCount: read.unreadableLineCount,
    stub: read.stub,
  };

  if (read.items.length === 0) {
    return emptyResult(
      'unreadable',
      'I cannot make out a single dish on this menu. Try a straighter shot with more light.',
      readSummary,
      0,
    );
  }

  // 2. Constraints, as a set intersection, before any further model call.
  //    Rows are handed in or fetched by the filter, applied, and dropped. This
  //    function never holds a value and has nothing to leak.
  const filtered = applyConstraintRows(
    input.userId ? [input.userId] : [],
    read.items.map((item, index) => ({
      id: String(index),
      name: item.name,
      description: item.description,
    })),
    options.constraintRows ?? [],
  );
  const constraintsAppliedCount = filtered.appliedCount;
  const surviving = filtered.candidates.map((c) => read.items[Number(c.id)]);

  if (surviving.length === 0) {
    return emptyResult(
      'unreadable',
      'Nothing on this menu is something I can put in front of you tonight.',
      readSummary,
      constraintsAppliedCount,
    );
  }

  // 3. phi, from Track A's extractor. Never a second prompt of our own.
  const venueName = (input.venueName ?? read.venueName ?? '').trim() || UNNAMED_VENUE;
  const items = menuItemsFor({ ...read, items: surviving }, venueName);

  let results: ExtractionResult[];
  let synthetic = false;
  if (options.extract) {
    results = await runExtraction(() => options.extract!(items), items);
  } else {
    const extractor = await loadCorpusExtractor();
    if (!extractor) {
      results = abstained(items);
    } else {
      synthetic = extractor.synthetic;
      results = await runExtraction(() => extractor.extractBatch(items), items);
      // toDishVector is the contract shape for a normalized extraction. Going
      // through it rather than reading the fields keeps this path pinned to
      // Track A's normalization if that shape ever changes.
      results = results.map((r, i) => ({ ...r, ...extractor.toDishVector(r), key: items[i].key }));
    }
  }

  const candidates: Candidate[] = surviving.map((item, i) => ({
    index: i,
    name: item.name,
    description: item.description,
    priceCents: item.priceCents,
    phi: results[i]?.phi ?? new Array(AXIS_COUNT).fill(0),
    confidence: results[i]?.confidence ?? new Array(AXIS_COUNT).fill(0),
    maskedAxes: results[i]?.maskedAxes ?? [...AXIS_KEYS],
  }));

  // 4. Readability against this reader's own axes.
  const readability = assessReadability(theta, candidates);
  readSummary.itemsReadable = readability.readableIdx.length;

  if (readability.readableIdx.length === 0) {
    return emptyResult(
      'unreadable',
      unreadablePreface(readability, read, synthetic),
      readSummary,
      constraintsAppliedCount,
    );
  }

  // 5. Rank, using Track A's frontier ranker. computeRegion on an empty history
  //    returns an unestablished region, which makes this a plain theta ranking
  //    and suppresses any expansion claim, which is the correct behaviour for a
  //    reader we know nothing about.
  const region = computeRegion(input.logs ?? []);
  const readable = readability.readableIdx.map((i) => candidates[i]);
  const frontier: FrontierCandidate[] = readable.map((c) => ({
    dishId: String(c.index).padStart(3, '0'),
    phi: c.phi,
    maskedIdx: c.maskedAxes.map((k) => AXIS_KEYS.indexOf(k)).filter((i) => i >= 0),
  }));
  const ranked = rankFrontier(frontier, region, theta);

  // 6 and 7. Packet, then render. A pick that cannot be rendered honestly is
  //          dropped and the next candidate is tried.
  const picks: MenuPick[] = [];
  for (const score of ranked) {
    if (picks.length >= maxPicks) break;
    const candidate = candidates[Number(score.dishId)];
    if (!candidate) continue;

    const coverage = readability.coverage[candidate.index] ?? 0;
    const pick = await renderOne({
      candidate,
      coverage,
      synthetic,
      theta,
      input,
      venueName,
      constraintsAppliedCount,
      expansion: expansionForPacket(score),
      renderOptions: options.render,
    });
    if (pick) picks.push(pick);
  }

  if (picks.length === 0) {
    return emptyResult(
      'degraded',
      'I read this menu but could not put an honest sentence together about any of it.',
      readSummary,
      constraintsAppliedCount,
    );
  }

  const preface = confidentPreface(readability, candidates.length, read, synthetic, picks.length);
  const status: MenuOrderStatus = synthetic || read.stub
    ? 'degraded'
    : preface === null
      ? 'ok'
      : 'partial';

  return { status, preface, picks, read: readSummary, constraintsAppliedCount };
}

/** 24 finite numbers, whatever the caller passed. A short or dirty theta is a cold start. */
function normalizeTheta(theta: Vec24 | undefined): Vec24 {
  const out = new Array(AXIS_COUNT).fill(0);
  if (!Array.isArray(theta)) return out;
  for (let i = 0; i < AXIS_COUNT; i++) {
    const v = theta[i];
    if (typeof v === 'number' && Number.isFinite(v)) out[i] = v;
  }
  return out;
}

/**
 * Run one extraction, and treat a failure as total abstention.
 *
 * The extractor throwing means we do not know what these dishes are. Abstaining
 * makes every dish unreadable, which routes into the honest refusal, and that
 * is a far better outcome than ranking a menu on zeros that look like measured
 * neutrality.
 */
async function runExtraction(
  call: () => Promise<ExtractionResult[]>,
  items: MenuItem[],
): Promise<ExtractionResult[]> {
  try {
    const out = await call();
    if (!Array.isArray(out) || out.length !== items.length) return abstained(items);
    return out;
  } catch {
    return abstained(items);
  }
}

interface RenderOneInput {
  candidate: Candidate;
  coverage: number;
  synthetic: boolean;
  theta: Vec24;
  input: MenuOrderInput;
  venueName: string;
  constraintsAppliedCount: number;
  expansion: ReturnType<typeof expansionForPacket>;
  renderOptions: RenderOptions | undefined;
}

/**
 * Build the packet for one candidate and render it, or return null.
 *
 * Null rather than a throw, and null rather than a degraded sentence, because
 * the caller has other candidates. Every failure here is either a packet the
 * privacy scan refused or text the validator refused, and in both cases the
 * right answer is to say nothing about this dish.
 */
async function renderOne(args: RenderOneInput): Promise<MenuPick | null> {
  const { candidate, coverage, synthetic, theta, input, venueName } = args;

  // A partial read is stated inside the packet so it lands inside the sentence.
  // A synthetic vector is not a partial read of a real dish, it is not a read
  // at all, so it caps confidence rather than adding a caveat that would claim
  // we looked at the photo.
  const caveats =
    !synthetic && coverage < WELL_READ_COVERAGE
      ? [{ source: 'extraction' as const, n: 1, claim: PARTIAL_READ_CAVEAT }]
      : [];

  try {
    const packet = buildEvidencePacket({
      user: {
        theta,
        nComparisons: input.nComparisons,
        posteriorVar: input.posteriorVar,
      },
      dish: {
        name: candidate.name,
        venueName,
        neighborhood: (input.neighborhood ?? '').trim(),
        priceCents: candidate.priceCents,
        phi: candidate.phi,
        confidence: candidate.confidence,
        maskedAxes: candidate.maskedAxes,
      },
      ...(args.expansion ? { expansion: args.expansion } : {}),
      caveats,
      sourceChannel: 'agent_vision',
      constraintsAppliedCount: args.constraintsAppliedCount,
      // An override may only lower. Synthetic vectors and a thin read are both
      // reasons to be told less confidently, never more.
      ...(synthetic || coverage < CONFIDENT_COVERAGE + 0.2 ? { confidence: 'low' as const } : {}),
    });

    const rendered = await renderRecommendation(packet, {
      ...args.renderOptions,
      // These dishes are not in the corpus, so there is no dish id to attach.
      // Inventing a local one would put an identifier into a client payload
      // that resolves to nothing.
      dishId: null,
    });

    return {
      dishName: candidate.name,
      priceCents: candidate.priceCents,
      text: rendered.text,
      packetId: rendered.packetId,
      confidence: packet.confidence,
    };
  } catch {
    // PacketLeakError, PacketInputError, or RenderValidationError. All three
    // mean this dish does not get spoken about, and none of them is something
    // the person on the other end can act on.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The honesty lines
// ---------------------------------------------------------------------------

/**
 * What to say when nothing on the menu can be judged for this reader.
 *
 * Names the axes, because "I cannot read this menu" is not actionable and
 * "nothing here tells me about chili heat, which is what your ordering turns
 * on" is: the reader can look at the menu and confirm it in a second.
 */
function unreadablePreface(
  readability: ReadabilityAssessment,
  read: MenuRead,
  synthetic: boolean,
): string {
  if (read.stub || synthetic) {
    return 'There are no model credentials configured, so this is a stub read rather than your photo.';
  }
  if (readability.unreadAxes.length > 0) {
    return (
      `I can read this menu but not the part of it that matters for you. ` +
      `Nothing here tells me about ${joinLabels(readability.unreadAxes.slice(0, 3))}, ` +
      `which is what your ordering turns on.`
    );
  }
  return 'I can see this menu but not well enough to judge any of it against your taste.';
}

/**
 * The hedge that runs alongside a real recommendation, or null.
 *
 * Null is the interesting case: when the photo read well there is nothing to
 * apologise for, and a hedge attached to a confident answer is noise that
 * teaches the reader to ignore the next one.
 */
function confidentPreface(
  readability: ReadabilityAssessment,
  totalCandidates: number,
  read: MenuRead,
  synthetic: boolean,
  pickCount: number,
): string | null {
  if (read.stub || synthetic) {
    return 'There are no model credentials configured, so this is a stub read rather than your photo.';
  }

  const readable = readability.readableIdx.length;
  const fraction = totalCandidates > 0 ? readable / totalCandidates : 0;
  const missedLines = read.unreadableLineCount;

  if (fraction >= WELL_READ_MENU_FRACTION && missedLines === 0) return null;

  const noun = pickCount === 1 ? 'the one' : `the ${spell(pickCount)}`;
  const seen = totalCandidates + missedLines;
  return (
    `I can only read ${readable} of ${seen} items on this menu well enough to judge them. ` +
    `Here ${pickCount === 1 ? 'is' : 'are'} ${noun} I am confident about.`
  );
}

export const __testing = {
  CONFIDENT_COVERAGE,
  DRIVING_AXIS_FLOOR,
  MAX_ITEMS,
  PARTIAL_READ_CAVEAT,
  READ_SYSTEM_PROMPT,
  base64Bytes,
  confidentPreface,
  joinLabels,
  stubRead,
  unreadablePreface,
};
