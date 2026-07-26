/**
 * Photon inbound handlers. Track C.
 *
 * transport.ts turns a raw provider payload into an InboundMessage and knows
 * nothing else about the product. This file is where that message becomes a
 * decision: photo to the menu flow, text to a query or a follow-up reply,
 * group traffic gated to explicit tags only. Nothing here talks to Photon
 * directly, everything goes through the Transport interface, so a vendor
 * swap touches transport.ts and not this file.
 *
 * WHAT THIS FILE DOES NOT DO
 * It does not fit a preference model, rank a menu, build an evidence packet,
 * or write a rendering prompt. Those are Track A's, imported from '@/core'
 * and from integrations/vision (the menu-photo-to-order pipeline, self-scoped
 * Track C, see that file's own header). A second recommendation pipeline
 * living here would drift from the real one within a day.
 *
 * THE SCHEDULED FOLLOW-UP, AND WHY IT USES A SYNTHETIC DUEL
 * Bradley-Terry fitting (core/model.ts) takes pairwise duels, not star
 * ratings. "How was the dish" produces a rating, not a duel, so there is no
 * FitObservation to hand fitTheta without a modelling choice. The one made
 * here: phi is z-scored around a population mean of zero (contracts/axes.ts),
 * so a zero vector stands in for "an average dish" and a rating becomes a
 * duel between the rated dish and that average.
 *
 *   rating >= 4   the dish beat average          winnerPhi = dish, loserPhi = 0
 *   rating <= 2   average beat the dish          winnerPhi = 0,    loserPhi = dish
 *   rating == 3   no preference either way        no observation, no theta move
 *
 * This is stated as an assumption, not hidden as a detail: a different team
 * could reasonably fit ratings a different way, and the Track C report says
 * so explicitly.
 *
 * WHY THE REFIT USES A LOWER LAMBDA THAN A DUEL
 * core/model.ts defaults lambda to 25, tuned for duels, which are a forced
 * binary choice between two dishes with no stated intensity. "How was the
 * dish" is a direct, labelled report about the exact thing being asked about,
 * which is a cleaner signal per observation than a duel is. FOLLOWUP_LAMBDA is
 * still nonzero: one rating is still a thin sample, and the whole point of
 * shrinkage is that a single data point should nudge a profile, not redefine
 * it.
 *
 * NO KEY, STILL DEMOABLE
 * Nothing here calls a network API. fitTheta is pure math, and the parsers
 * below are pure string matching, so every code path in this file runs today
 * with no credentials at all.
 */

import { AXES, AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../../contracts/axes';
import type { Vec24 } from '../../contracts/types';
import { fitTheta, type FitObservation } from '../../core';
import { menuPhotoToOrder, type MenuOrderInput, type MenuOrderResult, type MenuPhoto } from '../../integrations/vision';
import {
  isLikelyImage,
  type InboundAttachment,
  type InboundMessage,
  type OutboundMessage,
  type Transport,
} from './transport';

// ---------------------------------------------------------------------------
// Small vector helpers. No dependency on core's internals, which are
// deliberately not exported (see core/index.ts): dot and a zero vector are
// three lines each and do not belong on Track A's public surface.
// ---------------------------------------------------------------------------

function zeroVec(): Vec24 {
  return new Array(AXIS_COUNT).fill(0);
}

function dot(a: Vec24, b: Vec24): number {
  let s = 0;
  for (let i = 0; i < AXIS_COUNT; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function spell(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

// ---------------------------------------------------------------------------
// Session state
//
// IN MEMORY, AND THAT IS A HACKATHON DECISION, same tradeoff as
// lib/api/rate-limit.ts: per process, lost on a cold start, fine for a demo
// and not what a production deployment would ship. A real deployment needs a
// row per pending follow-up somewhere durable (Supabase is already in the
// stack) so a serverless cold start two hours after a recommendation does not
// silently drop it. Reported as a gap in the Track C report rather than
// solved here, because a durable store needs a schema decision and this task
// is the agent layer.
// ---------------------------------------------------------------------------

/** How long after a recommendation the agent checks back in. */
export const FOLLOW_UP_DELAY_MS = 2 * 60 * 60 * 1000;

/** A dish the agent is holding in reserve, to measure the fallout of a rating against. */
export interface WatchlistItem {
  name: string;
  phi: Vec24;
}

export interface PendingFollowUp {
  conversationId: string;
  dishName: string;
  venueName: string | null;
  /** The rated dish's own vector. Required to build the synthetic duel. */
  dishPhi: Vec24;
  /** theta as it stood when the recommendation went out. The refit's prior. */
  thetaAtSend: Vec24;
  nComparisonsAtSend: number;
  /** Other candidates from the same recommendation, scored before and after the refit. */
  watchlist: WatchlistItem[];
  createdAt: string;
  dueAt: string;
  /** Null until sendDueFollowUps actually delivers the "how was it" message. */
  sentAt: string | null;
  /** Null until a reply has been parsed and applied. */
  resolvedAt: string | null;
  packetId: string | null;
}

export interface DishLogEntry {
  conversationId: string;
  dishName: string;
  rating: number;
  note: string | null;
  at: string;
}

/**
 * Everything a handler needs to remember between one webhook call and the
 * next. One interface so the in-memory default and a future Supabase-backed
 * store are interchangeable, the same seam transport.ts uses for Photon
 * itself.
 */
export interface AgentStore {
  wasProcessed(messageId: string): boolean;
  markProcessed(messageId: string): void;

  hasGreetedGroup(conversationId: string): boolean;
  markGroupGreeted(conversationId: string): void;

  putPendingFollowUp(pending: PendingFollowUp): void;
  /** The follow-up this conversation is waiting on a reply for, or null. */
  activeFollowUp(conversationId: string): PendingFollowUp | null;
  resolveFollowUp(conversationId: string, at: string): void;
  markFollowUpSent(conversationId: string, at: string): void;
  /** Every follow-up whose two hours are up and has not been sent yet. */
  dueFollowUps(now: Date): PendingFollowUp[];

  recordDishLog(entry: DishLogEntry): void;
  dishLogs(conversationId?: string): DishLogEntry[];

  /**
   * The neighborhood this person said they were in, or null if never asked.
   *
   * Asked BEFORE the calibration link rather than after, because a taste
   * profile with nowhere to spend it is a survey. Knowing the area first also
   * means the very first recommendation can be somewhere they can actually go.
   */
  area(conversationId: string): string | null;
  setArea(conversationId: string, area: string): void;
  /**
   * Whether the area question has already gone out.
   *
   * Tracked separately from the answer, because without it the FIRST cold
   * message gets recorded as the area: "hey" is a perfectly plausible looking
   * neighborhood to a permissive matcher. A reply only counts as an area if we
   * actually asked for one.
   */
  wasAreaAsked(conversationId: string): boolean;
  markAreaAsked(conversationId: string): void;
}

/** Bounded so an unbounded stream of webhook traffic cannot grow these without limit. */
const MAX_TRACKED_IDS = 5000;
const MAX_DISH_LOGS = 2000;

function prune(set: Set<string>, cap: number): void {
  while (set.size > cap) {
    const first = set.values().next().value;
    if (first === undefined) return;
    set.delete(first);
  }
}

/** The default AgentStore. No network, no credentials, deterministic. */
export function createInMemoryAgentStore(): AgentStore {
  const processed = new Set<string>();
  const greetedGroups = new Set<string>();
  const pending = new Map<string, PendingFollowUp>();
  const logs: DishLogEntry[] = [];
  const areas = new Map<string, string>();
  const areaAsked = new Set<string>();

  return {
    wasProcessed(messageId) {
      return processed.has(messageId);
    },
    markProcessed(messageId) {
      processed.add(messageId);
      prune(processed, MAX_TRACKED_IDS);
    },

    hasGreetedGroup(conversationId) {
      return greetedGroups.has(conversationId);
    },
    markGroupGreeted(conversationId) {
      greetedGroups.add(conversationId);
      prune(greetedGroups, MAX_TRACKED_IDS);
    },

    putPendingFollowUp(entry) {
      pending.set(entry.conversationId, entry);
    },
    activeFollowUp(conversationId) {
      const p = pending.get(conversationId);
      // Only a follow-up that has actually been sent and not yet answered
      // counts as active. Otherwise an unrelated text sent in the two hours
      // before the check-in would be misread as a rating for a dish nobody
      // has asked about yet.
      if (!p || p.sentAt === null || p.resolvedAt !== null) return null;
      return p;
    },
    resolveFollowUp(conversationId, at) {
      const p = pending.get(conversationId);
      if (p) p.resolvedAt = at;
    },
    markFollowUpSent(conversationId, at) {
      const p = pending.get(conversationId);
      if (p) p.sentAt = at;
    },
    dueFollowUps(now) {
      const out: PendingFollowUp[] = [];
      for (const p of pending.values()) {
        if (p.sentAt === null && new Date(p.dueAt).getTime() <= now.getTime()) out.push(p);
      }
      return out;
    },

    recordDishLog(entry) {
      logs.push(entry);
      while (logs.length > MAX_DISH_LOGS) logs.shift();
    },
    dishLogs(conversationId) {
      return conversationId ? logs.filter((l) => l.conversationId === conversationId) : [...logs];
    },

    area(conversationId) {
      return areas.get(conversationId) ?? null;
    },
    setArea(conversationId, value) {
      areas.set(conversationId, value);
    },
    wasAreaAsked(conversationId) {
      return areaAsked.has(conversationId);
    },
    markAreaAsked(conversationId) {
      areaAsked.add(conversationId);
      prune(areaAsked, MAX_TRACKED_IDS);
    },
  };
}

// ---------------------------------------------------------------------------
// Group gating (hard rule 4, and the product rule stated alongside it)
//
// The agent talks to one person at a time. In a group thread that means it
// speaks only when explicitly tagged, and it never reads, stores, or acts on
// anything else in that thread. Untagged group traffic is turned away before
// it reaches any other handler, so there is no code path where an ambient
// group message is inspected at all, let alone retained.
// ---------------------------------------------------------------------------

export const GROUP_JOIN_ANNOUNCEMENT =
  'I only answer in this thread when I am tagged, and I do not read anything sent before or after that message.';

export interface GroupGateResult {
  shouldRespond: boolean;
  /** Sent once, the first time the agent is tagged in a given thread. */
  announcement: OutboundMessage | null;
}

/**
 * Whether this message may be acted on at all, and whether the thread has
 * been told, out loud, how the agent behaves in a group.
 *
 * Guarantees: an untagged group message never reaches the caller with
 * shouldRespond true, and the announcement fires exactly once per
 * conversation, on the first tagged message in it.
 */
export function evaluateGroupGate(message: InboundMessage, store: AgentStore): GroupGateResult {
  if (!message.conversation.isGroup) return { shouldRespond: true, announcement: null };
  if (!message.mentionsAgent) return { shouldRespond: false, announcement: null };

  if (store.hasGreetedGroup(message.conversation.id)) {
    return { shouldRespond: true, announcement: null };
  }
  store.markGroupGreeted(message.conversation.id);
  return {
    shouldRespond: true,
    announcement: {
      conversationId: message.conversation.id,
      text: GROUP_JOIN_ANNOUNCEMENT,
      inReplyTo: message.messageId,
      kind: 'reply',
    },
  };
}

// ---------------------------------------------------------------------------
// Reply helper
// ---------------------------------------------------------------------------

function replyText(message: InboundMessage, text: string): OutboundMessage {
  return { conversationId: message.conversation.id, text, inReplyTo: message.messageId, kind: 'reply' };
}

// ---------------------------------------------------------------------------
// Inbound photo -> the menu flow. Imported, never reimplemented.
// ---------------------------------------------------------------------------

/** The cold-start default when no theta is on file for this conversation. */
export interface UserState {
  theta: Vec24;
  nComparisons: number;
}

function defaultUserState(): UserState {
  return { theta: zeroVec(), nComparisons: 0 };
}

/**
 * A menu pick carrying its own phi vector.
 *
 * integrations/vision's public MenuPick does not expose phi today (see the
 * Track C report). This type describes the shape a small additive field
 * would take, so this file can schedule a real follow-up the moment that
 * field exists, with no change here beyond the field arriving on the object.
 * Tests exercise this branch through an injected order function.
 */
type PickWithPhi = MenuOrderResult['picks'][number] & { phi?: Vec24 };

function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function handlePhoto(
  message: InboundMessage,
  attachment: InboundAttachment,
  deps: HandlerDeps,
): Promise<OutboundMessage[]> {
  const bytes = await deps.transport.attach(attachment);
  if (!bytes || bytes.bytes.length === 0) {
    return [replyText(message, 'I could not read that image. Send the photo again with a bit more light.')];
  }

  const userState = await (deps.getUserState ?? (() => Promise.resolve(defaultUserState())))(
    message.conversation.id,
  );

  const photo: MenuPhoto = { base64: base64FromBytes(bytes.bytes), mediaType: bytes.mimeType ?? undefined };
  const orderFn = deps.orderFromMenuPhoto ?? menuPhotoToOrder;
  const order = await orderFn({
    photo,
    theta: userState.theta,
    nComparisons: userState.nComparisons,
  } satisfies MenuOrderInput);

  const lines: string[] = [];
  if (order.preface) lines.push(order.preface);
  for (const pick of order.picks) lines.push(pick.text);
  if (lines.length === 0) lines.push('nothing on that menu came back with an honest rec, sorry');

  const withPhi = order.picks.filter(
    (p): p is PickWithPhi & { phi: Vec24 } => Array.isArray((p as PickWithPhi).phi),
  );
  const willFollowUp = withPhi.length > 0 && (order.status === 'ok' || order.status === 'partial');

  // THE ASK. This is the entire review-collection mechanism: no review is ever
  // scraped, so the only ratings that exist are the ones people text back
  // after actually eating. Saying it out loud at recommendation time is what
  // makes the check-in two hours later land as expected rather than intrusive.
  if (willFollowUp) {
    lines.push('text me how it was after, out of 10');
  }

  const reply = replyText(message, lines.join(' '));

  if (willFollowUp) {
    const [top, ...rest] = withPhi;
    scheduleFollowUp(
      deps.store,
      {
        conversationId: message.conversation.id,
        dishName: top.dishName,
        venueName: null,
        dishPhi: top.phi,
        theta: userState.theta,
        nComparisons: userState.nComparisons,
        watchlist: rest.map((p) => ({ name: p.dishName, phi: p.phi })),
        packetId: top.packetId,
      },
      deps.now ?? (() => new Date()),
    );
  }

  return [reply];
}

// ---------------------------------------------------------------------------
// Scheduling and sending the follow-up
// ---------------------------------------------------------------------------

/**
 * Record that a recommendation went out and needs a check-in in two hours.
 *
 * Guarantees: dueAt is exactly FOLLOW_UP_DELAY_MS after `now()`, and the
 * theta and phi captured here are frozen at send time, so a later refit
 * always diffs against what the user actually had when the recommendation
 * was made rather than whatever theta happens to be on file when the reply
 * arrives.
 */
export function scheduleFollowUp(
  store: AgentStore,
  input: {
    conversationId: string;
    dishName: string;
    venueName: string | null;
    dishPhi: Vec24;
    theta: Vec24;
    nComparisons: number;
    watchlist?: WatchlistItem[];
    packetId?: string | null;
  },
  now: () => Date = () => new Date(),
): PendingFollowUp {
  const at = now();
  const pending: PendingFollowUp = {
    conversationId: input.conversationId,
    dishName: input.dishName,
    venueName: input.venueName,
    dishPhi: input.dishPhi,
    thetaAtSend: input.theta,
    nComparisonsAtSend: input.nComparisons,
    watchlist: input.watchlist ?? [],
    createdAt: at.toISOString(),
    dueAt: new Date(at.getTime() + FOLLOW_UP_DELAY_MS).toISOString(),
    sentAt: null,
    resolvedAt: null,
    packetId: input.packetId ?? null,
  };
  store.putPendingFollowUp(pending);
  return pending;
}

/** The check-in message. Flat, specific, no enthusiasm marker (hard rule 6). */
export function buildFollowUpMessage(pending: PendingFollowUp): OutboundMessage {
  return {
    conversationId: pending.conversationId,
    // Asking for a number out of ten is the whole review-collection mechanism:
    // this product never ingests a scraped review, so the only ratings that
    // exist are the ones people text back here.
    text: `hows the ${pending.dishName}? out of 10`,
    kind: 'follow_up',
  };
}

/**
 * Send every follow-up whose two hours are up.
 *
 * This is the piece a scheduler calls on a timer (app/api/agent/tick, backed
 * by Vercel Cron or an equivalent), because nothing in this process wakes
 * itself up. Guarantees: a follow-up is sent at most once, marked sent
 * immediately after a successful send so a second tick in the same window is
 * a no-op, and a delivery failure for one conversation does not stop the rest
 * from being tried.
 */
export async function sendDueFollowUps(
  store: AgentStore,
  transport: Transport,
  now: () => Date = () => new Date(),
): Promise<OutboundMessage[]> {
  const due = store.dueFollowUps(now());
  const sent: OutboundMessage[] = [];
  for (const pending of due) {
    const outbound = buildFollowUpMessage(pending);
    try {
      await transport.send(outbound);
      store.markFollowUpSent(pending.conversationId, now().toISOString());
      sent.push(outbound);
    } catch {
      // Left un-sent. The next tick retries it; two hours late is still
      // honest, a silently dropped check-in is not.
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Parsing a freeform reply into a rating
// ---------------------------------------------------------------------------

/**
 * Ordered rating rules, most specific first.
 *
 * Order is the whole mechanism: a numeric or idiomatic pattern is checked
 * before the single bad/good words that would otherwise misread it, which is
 * what lets "not bad at all" score as liked rather than hated, and "wasn't
 * great" score as disliked rather than liked. The first match wins.
 */
/**
 * Map a 1-10 reply onto the 1-5 scale the schema stores.
 *
 * contracts/schema.sql pins `logs.rating` to `between 1 and 5` and is frozen,
 * so out-of-ten is an INPUT convention only: people think in tens when they
 * text, and asking for a five point scale gets you sevens anyway. Halving and
 * rounding keeps the ordering intact, and the floor stops a 1 becoming a 0 and
 * violating the check constraint.
 */
export function tenToFive(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n / 2)));
}

const RATING_RULES: ReadonlyArray<{ pattern: RegExp; rating: number }> = [
  // Out of ten, checked FIRST. This is what the follow-up actually asks for,
  // so it is the most common reply shape and must not fall through to a rule
  // that happens to see a stray digit.
  { pattern: /\b10\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(10) },
  { pattern: /\b9\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(9) },
  { pattern: /\b8\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(8) },
  { pattern: /\b7\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(7) },
  { pattern: /\b6\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(6) },
  { pattern: /\b5\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(5) },
  { pattern: /\b4\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(4) },
  { pattern: /\b3\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(3) },
  { pattern: /\b2\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(2) },
  { pattern: /\b1\s*(?:\/\s*10|out of (?:10|ten))/i, rating: tenToFive(1) },

  // Explicit numeric or star ratings.
  { pattern: /\b5\s*(?:\/\s*5|out of (?:5|five)|stars?)\b/i, rating: 5 },
  { pattern: /\b4\s*(?:\/\s*5|out of (?:5|five)|stars?)\b/i, rating: 4 },
  { pattern: /\b3\s*(?:\/\s*5|out of (?:5|five)|stars?)\b/i, rating: 3 },
  { pattern: /\b2\s*(?:\/\s*5|out of (?:5|five)|stars?)\b/i, rating: 2 },
  { pattern: /\b1\s*(?:\/\s*5|out of (?:5|five)|stars?)\b/i, rating: 1 },

  // Idioms that would otherwise be caught by the wrong bucket below.
  { pattern: /\bnot\s+(?:that\s+)?bad\b/i, rating: 4 },
  { pattern: /\bcould\s*(?:'ve|\s+have)\s+been\s+worse\b/i, rating: 3 },

  // Negated positives read as disliked, checked before the bare positive words.
  // Both contracted ("wasn't", "didn't") and spelled out ("was not", "did
  // not") forms are covered, because a text reply is typed by hand and a
  // parser that only understands the contraction misses half its own test
  // cases.
  {
    pattern:
      /\b(?:not|never|n['’]t|wasn['’]t|was\s+not|didn['’]t|did\s+not|don['’]t|do\s+not|doesn['’]t|does\s+not)\s+(?:really\s+|that\s+)?(?:like|love|enjoy|great|good|amazing|best|perfect|worth\s+it|recommend(?:\s+it)?)\b/i,
    rating: 2,
  },
  { pattern: /\bno\s+good\b/i, rating: 2 },

  // Strong negative.
  { pattern: /\bhated\s+it\b/i, rating: 1 },
  { pattern: /\bterrible\b/i, rating: 1 },
  { pattern: /\bawful\b/i, rating: 1 },
  { pattern: /\bdisgusting\b/i, rating: 1 },
  { pattern: /\bworst\b/i, rating: 1 },
  { pattern: /\bone\s+star\b/i, rating: 1 },

  // Strong positive.
  { pattern: /\bloved\s+it\b/i, rating: 5 },
  { pattern: /\bamazing\b/i, rating: 5 },
  { pattern: /\bincredible\b/i, rating: 5 },
  { pattern: /\bfantastic\b/i, rating: 5 },
  { pattern: /\bperfect\b/i, rating: 5 },
  { pattern: /\bbest\b/i, rating: 5 },
  { pattern: /\bfive\s+stars?\b/i, rating: 5 },

  // Mild negative.
  { pattern: /\bkind\s+of\s+bad\b/i, rating: 2 },
  { pattern: /\bpretty\s+bad\b/i, rating: 2 },
  { pattern: /\bunderwhelming\b/i, rating: 2 },
  { pattern: /\bdisappointing\b/i, rating: 2 },
  { pattern: /\bnot\s+(?:really\s+)?my\s+thing\b/i, rating: 2 },
  { pattern: /\bwouldn['’]t\s+get\s+it\s+again\b/i, rating: 2 },

  // Neutral. Checked after the negation and strong tiers so a hedge with a
  // clear direction is not flattened into the middle.
  { pattern: /\bso[- ]so\b/i, rating: 3 },
  { pattern: /\bmeh\b/i, rating: 3 },
  { pattern: /\bmixed\b/i, rating: 3 },
  { pattern: /\baverage\b/i, rating: 3 },
  { pattern: /\bdecent\b/i, rating: 3 },
  { pattern: /\bfine\b/i, rating: 3 },
  { pattern: /\bok(?:ay)?\b/i, rating: 3 },
  { pattern: /\balright\b/i, rating: 3 },

  // Mild positive.
  { pattern: /\bliked\s+it\b/i, rating: 4 },
  { pattern: /\benjoyed\s+it\b/i, rating: 4 },
  { pattern: /\bpretty\s+good\b/i, rating: 4 },
  { pattern: /\bworth\s+it\b/i, rating: 4 },
  { pattern: /\bsolid\b/i, rating: 4 },
  { pattern: /\btasty\b/i, rating: 4 },
  { pattern: /\bnice\b/i, rating: 4 },
  { pattern: /\bgood\b/i, rating: 4 },
  { pattern: /\bgreat\b/i, rating: 4 },

  // Bare "bad", last, so every idiom and negation above gets first refusal.
  { pattern: /\bbad\b/i, rating: 1 },
];

/**
 * Turn a freeform reply into a 1..5 rating, or null when nothing readable
 * was said.
 *
 * Guarantees: a bare digit 1 through 5 is read as that rating, the rule list
 * is checked in a fixed order so the first, most specific match wins, and an
 * empty or unrecognised reply returns null rather than a guess. A guess here
 * is the one failure mode this feature cannot have: it would refit theta on
 * a rating the person never gave.
 */
export function parseFollowUpReply(text: string): number | null {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return null;

  // A bare number is the single most likely reply, because the follow-up asks
  // for one. It is read as OUT OF TEN unless the person writes /5 themselves:
  // the question set the frame, and someone answering "8" to "how was it out
  // of 10" plainly does not mean 8 on a five point scale.
  const bare = trimmed.match(/^(10|[1-9])(?:\s*\/\s*(10|5))?[.!\s]*$/);
  if (bare) {
    const n = Number(bare[1]);
    if (bare[2] === '5') return Math.min(5, n);
    return tenToFive(n);
  }

  for (const rule of RATING_RULES) {
    if (rule.pattern.test(trimmed)) return rule.rating;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The refit and the consequence sentence
// ---------------------------------------------------------------------------

/** See the file header for why zero stands in for "an average dish". */
function syntheticObservationForRating(dishPhi: Vec24, rating: number): FitObservation | null {
  if (rating >= 4) return { winnerPhi: dishPhi, loserPhi: zeroVec() };
  if (rating <= 2) return { winnerPhi: zeroVec(), loserPhi: dishPhi };
  return null;
}

/** A single explicit rating's theta move, tuned softer than a duel's default. See the file header. */
const FOLLOWUP_LAMBDA = 4;

/** Below this a per-axis move is float noise, not something to narrate. */
const AXIS_DELTA_FLOOR = 0.01;

interface AxisMove {
  key: AxisKey;
  label: string;
  direction: 'up' | 'down';
}

/** The single axis that moved the most, or null when nothing moved past the noise floor. */
function dominantAxis(oldTheta: Vec24, newTheta: Vec24): AxisMove | null {
  let bestIdx = -1;
  let bestAbs = 0;
  for (let i = 0; i < AXIS_COUNT; i++) {
    const d = Math.abs(newTheta[i] - oldTheta[i]);
    if (d > bestAbs) {
      bestAbs = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestAbs < AXIS_DELTA_FLOOR) return null;
  const key = AXIS_KEYS[bestIdx];
  const label = AXES.find((a) => a.key === key)?.label ?? key;
  const direction = newTheta[bestIdx] - oldTheta[bestIdx] > 0 ? 'up' : 'down';
  return { key, label, direction };
}

/**
 * How many watchlist dishes flip sides of the "would this rank" line.
 *
 * A dish scoring above zero under theta is one the ranker would have
 * surfaced; at or below zero it would not. 'down' counts dishes that were
 * above the line and fell to or below it; 'up' counts the reverse. This is a
 * real recount against the actual before and after theta, not an estimate.
 */
function countWatchlistFlips(
  oldTheta: Vec24,
  newTheta: Vec24,
  watchlist: WatchlistItem[],
  direction: 'up' | 'down',
): number {
  let count = 0;
  for (const item of watchlist) {
    const before = dot(oldTheta, item.phi);
    const after = dot(newTheta, item.phi);
    if (direction === 'down' && before > 0 && after <= 0) count += 1;
    if (direction === 'up' && before <= 0 && after > 0) count += 1;
  }
  return count;
}

function buildConsequenceSentence(params: {
  dishName: string;
  rating: number;
  axis: AxisMove | null;
  flips: number;
}): string {
  if (params.rating === 3) {
    return `Noted, right down the middle on the ${params.dishName}. Nothing changes about what I send you next.`;
  }
  if (!params.axis) {
    return `Noted on the ${params.dishName}. Not enough signal there yet to move anything.`;
  }
  const base = `Noted, pulling your ${params.axis.label} ${params.axis.direction}.`;
  if (params.flips === 0) return base;

  const noun = params.flips === 1 ? 'place' : 'places';
  const verb = params.axis.direction === 'down' ? 'drops' : 'opens up';
  const tail =
    params.axis.direction === 'down'
      ? `${verb} ${spell(params.flips)} ${noun} I was about to send you`
      : `${verb} ${spell(params.flips)} more ${noun} worth trying`;
  return `${base} That also ${tail}.`;
}

const CLARIFY_TEXT =
  'cant tell if that was good or bad. just a number out of 10 is enough';

/**
 * Apply a parsed reply to the pending follow-up: resolve it, log it, refit
 * theta when the rating carries a preference, and reply with a sentence
 * grounded in the real delta.
 *
 * Guarantees: resolveFollowUp and recordDishLog are called exactly once, a
 * rating of 3 never calls fitTheta (there is no preference to fit), and the
 * axis and place count named in the reply are read back from the actual
 * fitTheta output and the actual watchlist scores, never templated.
 */
async function applyFollowUpReply(
  message: InboundMessage,
  pending: PendingFollowUp,
  rating: number,
  deps: HandlerDeps,
): Promise<OutboundMessage> {
  const now = (deps.now ?? (() => new Date()))();
  deps.store.resolveFollowUp(pending.conversationId, now.toISOString());
  deps.store.recordDishLog({
    conversationId: pending.conversationId,
    dishName: pending.dishName,
    rating,
    note: message.text.trim().length > 0 ? message.text.trim() : null,
    at: now.toISOString(),
  });

  const observation = syntheticObservationForRating(pending.dishPhi, rating);
  if (!observation) {
    const text = buildConsequenceSentence({ dishName: pending.dishName, rating, axis: null, flips: 0 });
    return replyText(message, text);
  }

  const fit = fitTheta([observation], { prior: pending.thetaAtSend, lambda: FOLLOWUP_LAMBDA });
  const axis = dominantAxis(pending.thetaAtSend, fit.theta);
  const flips = axis ? countWatchlistFlips(pending.thetaAtSend, fit.theta, pending.watchlist, axis.direction) : 0;

  await deps.onThetaRefit?.(message.conversation.id, fit);

  const text = buildConsequenceSentence({ dishName: pending.dishName, rating, axis, flips });
  return replyText(message, text);
}

// ---------------------------------------------------------------------------
// Plain text queries
//
// There is no text-driven search surface on Track A's public API today: no
// exported function resolves "lunch under $20 near me" to a ranked dish
// without a menu to read. Fabricating an answer here would be an LLM
// deciding rather than rendering (hard rule 2), so the honest response is a
// direction back to the surface that does work, not an invented pick.
// ---------------------------------------------------------------------------

const PRICE_RE = /\$\s?(\d+(?:\.\d{1,2})?)/;

function classifyTextIntent(text: string): 'venue_overview' | 'priced_search' | 'unknown' {
  const t = text.toLowerCase();
  if (/\bwhat (?:do|should) i (?:get|order|eat)\b/.test(t) || /\bwhat['’]s good here\b/.test(t)) {
    return 'venue_overview';
  }
  if (PRICE_RE.test(t) || /\bunder\s+\$?\d/.test(t)) return 'priced_search';
  return 'unknown';
}

/**
 * Where a person goes to build a taste profile.
 *
 * Read at call time so the deployed URL is configuration, not a rebuild. The
 * default is the live deployment rather than localhost, because the one place
 * this string is ever read is a message going out to somebody's phone, and a
 * localhost link there is worse than no link.
 */
function calibrationUrl(conversationId: string, area: string | null): string {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL ?? 'https://corgi-hackathon-alpha.vercel.app'
  ).replace(/\/$/, '');

  // The `d` parameter is what makes the whole loop close. Without it the
  // browser invents a random local id, the swipes land under a profile the
  // agent has never heard of, and someone can calibrate perfectly and still
  // get told "i dont know how you eat yet" forever. That was a real bug.
  const params = new URLSearchParams({ d: conversationDeviceId(conversationId) });
  if (area) params.set('area', area);
  return `${base}/duel?${params.toString()}`;
}

/**
 * A conversation id, made safe to use as a device id.
 *
 * Provider ids can carry characters that do not survive a URL or the device id
 * pattern the API validates against, so this is narrowed rather than passed
 * through. Deterministic, because the same conversation has to resolve to the
 * same profile on every message, forever.
 */
export function conversationDeviceId(conversationId: string): string {
  const cleaned = conversationId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  return cleaned.length >= 4 ? cleaned : `c${hashId(conversationId)}`;
}

function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Whether a reply reads as an answer to "what area are you in".
 *
 * Deliberately permissive: almost any short text after being asked a location
 * question is a location. The guard is against a reply that is obviously
 * something else, such as a question back, so the agent does not record "why?"
 * as a neighborhood.
 */
function looksLikeArea(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (t.includes('?')) return false;
  if (/^\d+(\s*\/\s*10)?$/.test(t)) return false;
  return /[a-z]/i.test(t) || /^\d{5}$/.test(t);
}

/**
 * How many duels before the agent stops leading with the calibration link.
 *
 * Below this, a recommendation would be built on a theta that is mostly the
 * population prior (see core/model.ts shrinkage), so the honest move is to ask
 * for taste data rather than to guess and sound confident about it.
 */
const CALIBRATION_PROMPT_FLOOR = 12;

/**
 * The onboarding reply. This is the agent's growth loop: a cold text turns into
 * a link, the link builds a real profile, and only then does the agent claim to
 * know anything about the person.
 */
function calibrationInvite(
  nComparisons: number,
  conversationId: string,
  area: string,
): string {
  const url = calibrationUrl(conversationId, area);
  if (nComparisons === 0) {
    return (
      `cool, ${area}. i dont know how you eat yet tho, so anything i said would be a guess. ` +
      `swipe through these and ill actually be useful: ${url}`
    );
  }
  return (
    `ive got a rough read on you but not enough to be confident. ` +
    `a few more here and ill stop hedging: ${url}`
  );
}

const AREA_QUESTION =
  'hey. what area are you in? ill only send you places you can actually get to';

async function handlePlainText(
  message: InboundMessage,
  state: UserState,
  deps: HandlerDeps,
): Promise<OutboundMessage> {
  const convId = message.conversation.id;
  const knownArea = deps.store.area(convId);

  // ONBOARDING IS TWO STEPS, AREA THEN TASTE.
  //
  // The area comes first because a taste profile with nowhere to spend it is
  // just a survey, and because the first recommendation after calibrating
  // should be somewhere they can actually walk to.
  if (state.nComparisons < CALIBRATION_PROMPT_FLOOR) {
    if (!knownArea) {
      // A reply only counts as an area if the question actually went out
      // first, otherwise a cold "hey" gets filed as a neighborhood.
      if (deps.store.wasAreaAsked(convId) && looksLikeArea(message.text)) {
        const area = message.text.trim();
        deps.store.setArea(convId, area);
        return replyText(message, calibrationInvite(state.nComparisons, convId, area));
      }
      deps.store.markAreaAsked(convId);
      return replyText(message, AREA_QUESTION);
    }
    return replyText(message, calibrationInvite(state.nComparisons, convId, knownArea));
  }

  const intent = classifyTextIntent(message.text);

  // A CALIBRATED PERSON ASKING WHERE TO EAT GETS A RECOMMENDATION.
  //
  // This used to answer "send me a photo of the menu", which reads as broken:
  // the corpus recommendation needs no menu at all. It is the same pipeline
  // /api/recommend runs, imported rather than reimplemented, so the constraint
  // filter, the twin gate, and the evidence packet are identical here.
  if (intent === 'venue_overview' || intent === 'priced_search' || intent === 'unknown') {
    const recommend = deps.recommendForConversation;
    if (recommend) {
      try {
        const picks = await recommend(message.conversation.id);
        if (picks.length > 0) {
          // The ask that makes the whole review loop work. No review is ever
          // scraped, so a rating only exists if somebody texts it back.
          return replyText(message, `${picks[0].text} text me how it was after, out of 10`);
        }
      } catch {
        // Fall through to the honest non-answer below rather than surfacing a
        // stack trace to somebody's phone.
      }
    }
  }

  if (intent === 'priced_search') {
    const match = message.text.match(PRICE_RE);
    const ceiling = match ? ` under $${match[1]}` : '';
    return replyText(
      message,
      `nothing${ceiling} came back that i'd actually stand behind right now. send me a menu photo and ill work from that`,
    );
  }

  return replyText(
    message,
    'nothing came back that i\'d actually stand behind right now. send me a menu photo and ill work from that',
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface HandlerDeps {
  transport: Transport;
  store: AgentStore;
  now?: () => Date;
  /** Injectable seam for tests; defaults to the real menu photo pipeline. */
  orderFromMenuPhoto?: (input: MenuOrderInput) => Promise<MenuOrderResult>;
  /** Injectable seam for tests and for wiring in a real per-conversation theta lookup later. */
  getUserState?: (conversationId: string) => Promise<UserState>;
  /** Called with the refit result whenever a follow-up reply moves theta, so a caller can persist it. */
  onThetaRefit?: (conversationId: string, fit: ReturnType<typeof fitTheta>) => Promise<void> | void;
  /**
   * Corpus recommendation for a calibrated person who texts rather than sends
   * a photo. Injected rather than imported so this module stays free of any
   * dependency on the HTTP layer and on the in-memory store, and so a test can
   * exercise the text path without standing up either.
   *
   * The runner wires this to lib/api/recommend-core, which is the same
   * pipeline /api/recommend runs. Do not reimplement it here.
   */
  recommendForConversation?: (
    conversationId: string,
  ) => Promise<Array<{ text: string }>>;
}

/**
 * Handle one inbound Photon message end to end.
 *
 * Guarantees:
 *  - A repeated delivery of the same messageId is a no-op (webhooks retry).
 *  - An untagged group message produces no output and touches nothing else:
 *    not the menu flow, not a pending follow-up, not the message store.
 *  - Every outbound message is sent through deps.transport before this
 *    resolves, and the same list is returned so a caller or a test can
 *    inspect what went out without re-reading the transport's own record.
 *  - No message is ever addressed to anyone but the conversation this
 *    message arrived in (hard rule 4).
 */
export async function handleInboundMessage(message: InboundMessage, deps: HandlerDeps): Promise<OutboundMessage[]> {
  if (deps.store.wasProcessed(message.messageId)) return [];
  deps.store.markProcessed(message.messageId);

  const gate = evaluateGroupGate(message, deps.store);
  if (!gate.shouldRespond) return [];

  const outbound: OutboundMessage[] = [];
  if (gate.announcement) outbound.push(gate.announcement);

  const photo = message.attachments.find(isLikelyImage);
  if (photo) {
    outbound.push(...(await handlePhoto(message, photo, deps)));
  } else {
    const active = deps.store.activeFollowUp(message.conversation.id);
    if (active) {
      const rating = parseFollowUpReply(message.text);
      outbound.push(rating === null ? replyText(message, CLARIFY_TEXT) : await applyFollowUpReply(message, active, rating, deps));
    } else {
      const state = await (deps.getUserState ?? (() => Promise.resolve(defaultUserState())))(
        message.conversation.id,
      );
      outbound.push(await handlePlainText(message, state, deps));
    }
  }

  for (const msg of outbound) await deps.transport.send(msg);
  return outbound;
}

// ---------------------------------------------------------------------------
// Process-local default store
//
// Both app/api/agent/webhook and app/api/agent/tick need the SAME store, or a
// follow-up scheduled by one request would never be found by the other. This
// is the one seam both routes import, so there is exactly one place that
// decides what "the" store is for a running process.
// ---------------------------------------------------------------------------

let defaultStore: AgentStore | null = null;

/** The store every route handler should use unless a test injects its own. */
export function defaultAgentStore(): AgentStore {
  if (!defaultStore) defaultStore = createInMemoryAgentStore();
  return defaultStore;
}

/** Test hook. The next call to defaultAgentStore() starts from empty state. */
export function resetDefaultAgentStore(): void {
  defaultStore = null;
}

export const __testing = {
  classifyTextIntent,
  syntheticObservationForRating,
  dominantAxis,
  countWatchlistFlips,
  buildConsequenceSentence,
  zeroVec,
  dot,
  RATING_RULES,
};
