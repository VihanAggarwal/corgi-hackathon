/**
 * Degradation notices and the redactor. Track C.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT
 * A demo that quietly fell back to a stub and looks identical to a demo that
 * worked. Conference wifi will drop at least once, and when it does the
 * presenter has to be able to say what state the system is in without reading
 * a server log. So every fallback produces a DegradedNotice, every notice is
 * recorded in a process-local ring buffer, and /api/health reports the buffer.
 * Nothing here is optional decoration: a silent fallback is the bug.
 *
 * WHY THE REDACTOR IS NOT PARANOIA
 * The detail string on a notice is built from an exception message and then
 * handed to a route response. Fetch and the Supabase and Anthropic clients all
 * put the request URL in the message, and a request URL routinely carries an
 * API key in a query parameter. Redacting at the point the notice is built is
 * the only place that covers every producer at once.
 */

/** Why a dependency stopped being usable. */
export type DegradeReason =
  | 'timeout'
  | 'error'
  | 'aborted'
  | 'budget_exhausted'
  | 'not_configured'
  | 'unavailable';

export interface DegradedNotice {
  /** Dependency name, as it appears in /api/health. */
  dependency: string;
  reason: DegradeReason;
  /** Redacted, truncated, human-readable. Safe to put in a response body. */
  detail: string;
  /** How many attempts were made before giving up. */
  attempts: number;
  at: string;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Patterns matched on the VALUE, not on a variable name, because by the time a
 * key is inside an exception message its name is long gone. Each one is a
 * credential shape we actually carry: Anthropic, Supabase (a JWT), Google, and
 * the generic long opaque token that Merge and Photon are likely to use.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_\-]{8,}/g, 'sk-ant-[redacted]'],
  [/sk-[A-Za-z0-9_\-]{16,}/g, 'sk-[redacted]'],
  [/eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+/g, '[redacted-jwt]'],
  [/AIza[A-Za-z0-9_\-]{10,}/g, '[redacted-google-key]'],
  [/\b[A-Za-z0-9_\-]{40,}\b/g, '[redacted-token]'],
];

/** Query strings are where a key most often rides along in a fetch error. */
const QUERY_STRING = /(\?|&)[^\s'"]+/g;

const MAX_DETAIL_LENGTH = 240;

/**
 * Strip anything credential-shaped from a message and bound its length.
 *
 * Guarantees: the returned string contains no substring matching a known
 * credential shape and no URL query string, and is at most MAX_DETAIL_LENGTH
 * characters. Order matters: query strings go first, so a key sitting in one is
 * removed wholesale rather than depending on its shape being recognized.
 */
export function redact(message: string): string {
  let out = message.replace(QUERY_STRING, '$1[redacted-query]');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_DETAIL_LENGTH ? `${out.slice(0, MAX_DETAIL_LENGTH)}...` : out;
}

/**
 * A redacted one-line description of an unknown thrown value.
 *
 * Guarantees: never throws, never returns an empty string, and never returns a
 * stack trace. Anything can be thrown in JavaScript, including a string, and a
 * health endpoint that dies formatting an error is worse than the error.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
    return redact(`${name}${error.message}`) || redact(name) || 'unknown error';
  }
  if (typeof error === 'string') return redact(error) || 'unknown error';
  try {
    return redact(JSON.stringify(error)) || 'unknown error';
  } catch {
    return 'unknown error';
  }
}

// ---------------------------------------------------------------------------
// The observability buffer
// ---------------------------------------------------------------------------

/**
 * Bounded on purpose. A retry storm during a dead-wifi minute can produce
 * hundreds of notices, and an unbounded array in a long-lived server process is
 * a memory leak that only shows up under exactly the conditions this module
 * exists for.
 */
const CAPACITY = 50;

const log: DegradedNotice[] = [];

/**
 * Record a degradation so a human can see it later.
 *
 * Guarantees: never throws, keeps at most CAPACITY notices, and drops the
 * oldest first. Returns the notice so a caller can both record and return it.
 */
export function recordDegradation(notice: DegradedNotice): DegradedNotice {
  log.push(notice);
  while (log.length > CAPACITY) log.shift();
  return notice;
}

/**
 * The most recent degradations, newest first.
 *
 * Guarantees: returns a copy, so a caller cannot mutate the buffer, and never
 * more than `limit` entries.
 */
export function recentDegradations(limit = CAPACITY): DegradedNotice[] {
  return log.slice(-limit).reverse();
}

/** Empty the buffer. Exists for tests and for a presenter resetting between runs. */
export function clearDegradations(): void {
  log.length = 0;
}

/** Capacity of the ring buffer. Exported so a test can assert the bound rather than guess it. */
export const DEGRADATION_LOG_CAPACITY = CAPACITY;
