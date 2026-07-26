/**
 * Conversational framing for the agent, via Anthropic.
 *
 * WHY THIS EXISTS
 * The regex-based intent classifier in handlers.ts is dumb by construction: it
 * cannot follow a real conversation, so replies to anything outside its
 * patterns felt scripted and repetitive. This routes the CONVERSATIONAL TEXT
 * through a real model call.
 *
 * WHAT THE MODEL MAY AND MAY NOT DO
 * It never invents a dish or venue. Recommendations are computed exactly as
 * before, by recommend-core.ts, and handed here as already-rendered strings.
 * The model's only job is deciding what to SAY around them: how to greet,
 * how to ask a follow up, how to steer off-topic chat back. Hard rule 2
 * ("the LLM renders, it never decides") still holds for WHICH dish; this file
 * only lets the model decide the surrounding words, which was previously a
 * fixed regex tree pretending to be a person.
 *
 * DEGRADES WITHOUT A KEY
 * Same pattern as core/render.ts: no ANTHROPIC_API_KEY, no call, callers get
 * null back and fall back to the canned lines that already existed.
 */

import Anthropic from '@anthropic-ai/sdk';
// Relative, not the "@/" alias: this module is loaded by tsx (the Photon
// runner) as well as by Next, and tsx does not resolve tsconfig path aliases
// without extra config. core/render.ts and portrait.ts hit the same
// constraint; this follows the same fix.
import { anthropicClientOptions, hasModelCredentials } from '../../core/anthropic-client';

export interface ConverseInput {
  /** What the person just said. */
  message: string;
  /** Their neighborhood, if known. */
  area: string | null;
  /** True once they have swiped enough to get real recommendations. */
  calibrated: boolean;
  /**
   * Already-rendered recommendation text, computed by the real pipeline.
   * Present only when this turn resolved to a recommendation. The model MUST
   * use these verbatim (or trivially reworded) and must not add another.
   */
  picks: string[] | null;
}

const SYSTEM_PROMPT = `you are texting as a friend who knows food, replying inside an iMessage thread.

voice: lowercase, contractions, short. text like a person, not a review. no
exclamation points in food talk. no "amazing", "must try", "delicious".

rules that cannot bend:
- if "picks" are given below, you MUST include all of them, each on its own
  line, close to verbatim. never invent a restaurant or dish that is not in
  picks. never add a fourth option.
- if picks are empty and the message is a real food question, say honestly
  you don't have a solid pick right now, in one line.
- if the message has nothing to do with food (small talk, questions about you,
  random chat), answer it in one short line, then steer back to food in a
  second line. never write more than 2 lines for off-topic chat.
- if this is a returning "hey"/greeting with no ask, respond warmly and ask
  what they're feeling like eating. do not recommend anything yet.
- always end a recommendation turn by asking for a rating out of 10 after they
  eat, in your own words, once.
- output PLAIN TEXT MESSAGES, one per line, 1 to 3 lines total. no markdown,
  no numbering, no quotes around it.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic(anthropicClientOptions());
  return client;
}

/**
 * Ask the model how to frame this turn. Returns null on any failure or with
 * no credentials, so callers can fall back to the deterministic copy that
 * already exists rather than break the conversation.
 */
export async function converseReply(input: ConverseInput): Promise<string[] | null> {
  if (!hasModelCredentials()) return null;

  const context = [
    `message: ${JSON.stringify(input.message)}`,
    `area: ${input.area ?? 'unknown'}`,
    `calibrated: ${input.calibrated}`,
    input.picks && input.picks.length > 0
      ? `picks:\n${input.picks.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : 'picks: none',
  ].join('\n');

  try {
    const res = await anthropic().messages.create({
      model: 'claude-opus-5',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: context }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) return null;

    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4);

    // If picks were given, refuse a reply that dropped one: better to fall
    // back to the deterministic composer than silently lose a recommendation.
    if (input.picks) {
      const joined = lines.join(' ').toLowerCase();
      const missing = input.picks.some(
        (p) => !joined.includes(p.slice(0, 24).toLowerCase()),
      );
      if (missing) return null;
    }

    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}
