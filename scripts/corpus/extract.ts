/**
 * Dish attribute extraction. Track A.
 *
 * Turns a menu line into a 24-dim phi plus a 24-dim per-axis confidence array.
 *
 * THE CRITICAL PROPERTY IS ABSTENTION. A hallucinated "this is spicy" poisons
 * every model downstream: it corrupts theta for every user who duels that dish,
 * and corrupted theta produces wrong twins, which is the one failure the whole
 * product cannot survive. The prompt is therefore built to make "I cannot tell
 * from this text" the cheap, expected answer rather than a failure.
 *
 * Axes below CONF_THRESHOLD are masked and must never be used for fitting or
 * spoken by the renderer.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AXES, AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../../contracts/axes';
import { CONSTANTS, type Conf24, type DishVector, type Vec24 } from '../../contracts/types';
import { DRY_RUN, EXTRACTION_MODEL, KEYS } from './config';

export interface MenuItem {
  /** Stable key for checkpointing: `${venueGPlaceId}::${dishName}` */
  key: string;
  venueKey: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  /** Cuisine hint from the venue. Context only, never a substitute for evidence. */
  venueCuisine: string | null;
}

export interface ExtractionResult {
  key: string;
  phi: Vec24;
  confidence: Conf24;
  maskedAxes: AxisKey[];
  /** Model's own note when it could not read the dish at all. */
  abstainedEntirely: boolean;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The axis block is generated from the frozen contract rather than hand-written
 * so the prompt can never drift out of sync with the vector layout.
 */
function axisBlock(): string {
  return AXES.map(
    (a, i) => `${i}. ${a.key} (${a.label}): -3 = ${a.low}, +3 = ${a.high}`,
  ).join('\n');
}

const SYSTEM_PROMPT = `You extract sensory attributes of restaurant dishes onto a fixed 24-axis scale.

THE AXES. Index position is fixed and must not be reordered.
${axisBlock()}

SCALE. Every value is z-scored against the population of all restaurant dishes,
roughly -3 to +3, where 0 is a completely typical dish. Most dishes are near 0
on most axes. A dish is not "high heat" because it contains any chili; it is
high heat relative to all dishes everywhere.

CONFIDENCE IS THE POINT OF THIS TASK.
For each axis you return a confidence from 0 to 1 describing how well the text
you were given actually determines that axis.

- 0.9+ : the text states it or the dish is so standardized it is not in doubt
         ("mapo tofu" is numbing; "cacio e pepe" is not spicy)
- 0.6  : strongly implied by cuisine and preparation, but not stated
- 0.3  : you are guessing from the dish category alone
- 0.0  : the text does not determine this axis at all

A LOW CONFIDENCE IS A CORRECT ANSWER, NOT A FAILURE. You are scored on
calibration, not on coverage. A dish listed only as "House Salad" with no
description should return near-zero confidence on nearly every axis. Guessing
there is strictly worse than abstaining, because a wrong attribute silently
corrupts a downstream preference model that no human will ever audit.

Never infer an attribute from the restaurant's cuisine alone when the dish
itself is unremarkable within that cuisine. "It is a Thai restaurant" does not
make a plain rice dish spicy.

If the input is not a food dish at all (a drink, a section header like
"APPETIZERS", a note about allergens), set every confidence to 0 and set
"not_a_dish": true.

OUTPUT. Return only a JSON array, one object per input dish, in the same order:
[{"i": 0, "phi": [24 numbers], "conf": [24 numbers], "not_a_dish": false}]
No prose, no markdown fence.`;

function userPrompt(items: MenuItem[]): string {
  const lines = items.map((it, i) => {
    const parts = [`${i}. ${it.name}`];
    if (it.description) parts.push(`   description: ${it.description}`);
    if (it.venueCuisine) parts.push(`   venue cuisine: ${it.venueCuisine}`);
    return parts.join('\n');
  });
  return `Extract these ${items.length} menu items:\n\n${lines.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

interface RawExtraction {
  i: number;
  phi: number[];
  conf: number[];
  not_a_dish?: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Coerce a model response into valid vectors. Anything structurally wrong is
 * downgraded to zero confidence rather than thrown away, because a dish with no
 * usable attributes is still a real dish that can appear in a recommendation.
 * It simply must never participate in model fitting.
 */
function normalize(raw: RawExtraction, key: string): ExtractionResult {
  const zeroes = (): number[] => new Array(AXIS_COUNT).fill(0);

  const phiIn = Array.isArray(raw.phi) && raw.phi.length === AXIS_COUNT ? raw.phi : zeroes();
  const confIn = Array.isArray(raw.conf) && raw.conf.length === AXIS_COUNT ? raw.conf : zeroes();

  const notADish = raw.not_a_dish === true;

  const phi: Vec24 = phiIn.map((v) => (Number.isFinite(v) ? clamp(Number(v), -3, 3) : 0));
  const confidence: Conf24 = confIn.map((v) =>
    notADish ? 0 : Number.isFinite(v) ? clamp(Number(v), 0, 1) : 0,
  );

  const maskedAxes: AxisKey[] = [];
  for (let i = 0; i < AXIS_COUNT; i++) {
    if (confidence[i] < CONSTANTS.CONF_THRESHOLD) {
      maskedAxes.push(AXIS_KEYS[i]);
      // A masked axis must not leak a value into anything downstream that
      // forgets to check the mask. Zero it at the source.
      phi[i] = 0;
    }
  }

  return {
    key,
    phi,
    confidence,
    maskedAxes,
    abstainedEntirely: maskedAxes.length === AXIS_COUNT,
  };
}

function parseResponse(text: string, items: MenuItem[]): ExtractionResult[] {
  // Models occasionally wrap JSON in a fence despite instructions.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Extraction returned unparseable JSON: ${cleaned.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Extraction did not return an array');
  }

  const byIndex = new Map<number, RawExtraction>();
  for (const r of parsed as RawExtraction[]) {
    if (typeof r?.i === 'number') byIndex.set(r.i, r);
  }

  return items.map((item, i) => {
    const raw = byIndex.get(i);
    if (!raw) {
      // Missing entry means the model dropped a dish. Abstain rather than
      // silently shifting the array and mislabeling every dish after it.
      return normalize({ i, phi: [], conf: [], not_a_dish: true }, item.key);
    }
    return normalize(raw, item.key);
  });
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/** Deterministic hash so dry runs are reproducible across machines. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Synthetic extraction that mimics the real distribution: most axes uncertain,
 * a few confident. Used so every downstream stage is testable without keys.
 */
function dryRunExtract(items: MenuItem[]): ExtractionResult[] {
  return items.map((item) => {
    const seed = hash(item.key);
    const phi: number[] = [];
    const conf: number[] = [];
    for (let i = 0; i < AXIS_COUNT; i++) {
      const r = hash(`${item.key}:${i}:${seed}`) / 0xffffffff;
      const r2 = hash(`${item.key}:c:${i}`) / 0xffffffff;
      phi.push(Number(((r - 0.5) * 4).toFixed(3)));
      // Roughly a third of axes clear the confidence threshold, which is what
      // real menu text supports.
      conf.push(Number((r2 * 0.55 + (r2 > 0.65 ? 0.4 : 0)).toFixed(3)));
    }
    return normalize({ i: 0, phi, conf }, item.key);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: KEYS.anthropic });
  return client;
}

/** Extract one batch. Throws on unrecoverable parse failure so the caller can retry. */
export async function extractBatch(items: MenuItem[]): Promise<ExtractionResult[]> {
  if (items.length === 0) return [];
  if (DRY_RUN) return dryRunExtract(items);

  const res = await anthropic().messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt(items) }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseResponse(text, items);
}

/** Convert an extraction result into the shared DishVector contract shape. */
export function toDishVector(r: ExtractionResult): DishVector {
  return { phi: r.phi, confidence: r.confidence, maskedAxes: r.maskedAxes };
}

export const __testing = { normalize, parseResponse, SYSTEM_PROMPT };
