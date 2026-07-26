/**
 * Token bucket rate limiting. Track C.
 *
 * IN MEMORY, AND THAT IS A HACKATHON DECISION
 * The buckets live in a module-level Map, so they are per process. On Vercel
 * that means per warm lambda: ten concurrent instances give an attacker ten
 * times the budget, and a cold start resets the count to full. This is stated
 * plainly rather than hidden because the fix is not subtle and is not free.
 *
 * WHAT PRODUCTION NEEDS
 * A shared counter with an atomic decrement, Upstash Redis or Vercel KV being
 * the two that fit this stack, keyed the same way this module keys. The
 * interface below is deliberately the one a Redis implementation can satisfy
 * without any caller changing: take a key, get back allowed plus a retry hint.
 *
 * WHY A BUCKET RATHER THAN A FIXED WINDOW
 * The duel feed is bursty by design. A person answers ten duels in twenty
 * seconds and then stops, and a fixed window either rejects the burst or sets
 * the sustained rate far too high. A bucket lets the burst through and still
 * caps the hour.
 */

export interface BucketConfig {
  /** Maximum burst. The bucket starts full. */
  capacity: number;
  /** Sustained rate once the burst is spent. */
  refillPerSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Whole tokens left after this call. Diagnostic, never returned to a client. */
  remaining: number;
  /** Seconds until one token exists. Zero when the call was allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  /** Epoch ms of the last refill, so an idle bucket does not accrue in a loop. */
  updatedAt: number;
}

/**
 * Bounded so a flood of distinct device ids cannot grow the map without limit.
 * At the cap the oldest half is dropped, which is a small correctness loss (a
 * dropped bucket restarts full) taken deliberately over an unbounded map that
 * turns a rate limiter into the outage it was meant to prevent.
 */
const MAX_TRACKED_KEYS = 20_000;

const buckets = new Map<string, Bucket>();

function prune(now: number): void {
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  const entries = [...buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (let i = 0; i < entries.length / 2; i++) buckets.delete(entries[i][0]);
  // Touch nothing else. A prune is a capacity event, not a reset.
  void now;
}

/**
 * Consume one token for a key.
 *
 * Guarantees: never throws, never blocks, and the first `capacity` calls in a
 * cold bucket are always allowed. `retryAfterSeconds` is a lower bound on when
 * a retry can succeed, so a client honoring it will not be refused twice for
 * the same reason.
 */
export function takeToken(
  key: string,
  config: BucketConfig,
  now: number = Date.now(),
): RateLimitResult {
  prune(now);

  const existing = buckets.get(key);
  const bucket: Bucket = existing ?? { tokens: config.capacity, updatedAt: now };

  if (existing) {
    const elapsedSeconds = Math.max(0, (now - existing.updatedAt) / 1000);
    bucket.tokens = Math.min(config.capacity, existing.tokens + elapsedSeconds * config.refillPerSecond);
    bucket.updatedAt = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  buckets.set(key, bucket);
  const deficit = 1 - bucket.tokens;
  const wait = config.refillPerSecond > 0 ? deficit / config.refillPerSecond : Number.POSITIVE_INFINITY;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Number.isFinite(wait) ? wait : 3600,
  };
}

/**
 * Drop every bucket.
 *
 * Guarantees: the next call for any key sees a full bucket. Exists for tests,
 * which would otherwise leak a spent bucket from one case into the next.
 */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Per-route budgets.
 *
 * Answering a duel is the highest-frequency real action in the product, so it
 * gets the largest burst. Recommend and portrait are the two that can reach a
 * paid model, so their sustained rate is the one that matters: at four per
 * minute a single device cannot run up a bill faster than a person can read.
 */
export const LIMITS = {
  duelNext: { capacity: 30, refillPerSecond: 0.5 },
  duelAnswer: { capacity: 60, refillPerSecond: 1 },
  profile: { capacity: 30, refillPerSecond: 0.5 },
  portrait: { capacity: 5, refillPerSecond: 4 / 60 },
  recommend: { capacity: 8, refillPerSecond: 4 / 60 },
  cardCreate: { capacity: 10, refillPerSecond: 0.1 },
  cardRead: { capacity: 60, refillPerSecond: 1 },
  compare: { capacity: 15, refillPerSecond: 0.25 },
} as const satisfies Record<string, BucketConfig>;
