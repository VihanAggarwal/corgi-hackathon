/**
 * The external-call wrapper. Track C.
 *
 * Every call that leaves this process (Anthropic, Places, Merge, Photon,
 * Supabase) goes through withFallback. It gives that call three things:
 * a deadline, a bounded retry, and a degraded value to return instead of
 * throwing.
 *
 * THE FALLBACK MATTERS MORE THAN THE RETRY.
 * Conference wifi is assumed to fail during the demo. A demo that degrades in
 * 400ms survives; a demo that retries for thirty seconds is over, because the
 * audience has already watched a spinner for half a minute. So the defaults are
 * short, the total wall clock is bounded independently of the attempt count,
 * and the fallback is a required argument rather than an option. There is no
 * way to call this and forget to supply one.
 *
 * WHY IT RETURNS A RESULT INSTEAD OF THROWING
 * A thrown error at a route boundary becomes a 500, and a 500 during a demo is
 * a blank screen. The result carries `degraded` and, when degraded, the notice
 * explaining why, so the caller can serve real content and still tell the truth
 * about where it came from. Callers must not discard that field: a fallback the
 * user cannot see is indistinguishable from a success, which is the exact
 * failure this module is built to prevent.
 */

import {
  describeError,
  recordDegradation,
  type DegradeReason,
  type DegradedNotice,
} from './degradation';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The operation did not finish inside its per-attempt deadline. */
export class TimeoutError extends Error {
  readonly dependency: string;
  readonly timeoutMs: number;

  constructor(dependency: string, timeoutMs: number) {
    super(`${dependency} did not respond within ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.dependency = dependency;
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's own AbortSignal fired. Distinct from a timeout: nobody is waiting. */
export class OperationAbortedError extends Error {
  readonly dependency: string;

  constructor(dependency: string) {
    super(`${dependency} call was aborted by the caller`);
    this.name = 'OperationAbortedError';
    this.dependency = dependency;
  }
}

/**
 * The fallback itself threw.
 *
 * This is the one case withFallback cannot absorb, and it is always a bug in
 * the caller rather than a network condition: a fallback that can fail is not a
 * fallback. It throws loudly so the bug is found at development time and not on
 * stage.
 */
export class FallbackFailedError extends Error {
  readonly dependency: string;
  readonly notice: DegradedNotice;

  constructor(dependency: string, notice: DegradedNotice, cause: unknown) {
    super(
      `Fallback for ${dependency} threw after the live path degraded ` +
        `(${notice.reason}: ${notice.detail}): ${describeError(cause)}`,
    );
    this.name = 'FallbackFailedError';
    this.dependency = dependency;
    this.notice = notice;
  }
}

// ---------------------------------------------------------------------------
// Timeout primitive
// ---------------------------------------------------------------------------

/**
 * Run an operation with a hard deadline.
 *
 * Guarantees: the returned promise settles within `timeoutMs` even if the
 * operation never settles, the operation is handed an AbortSignal that fires at
 * the deadline so a well-behaved client can cancel its socket, and no timer is
 * left pending afterwards. An operation that ignores the signal is abandoned
 * rather than awaited, which is the whole point: we cannot make a hung socket
 * return, we can only stop waiting for it.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  dependency = 'operation',
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onOuterAbort: (() => void) | undefined;

  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(dependency, timeoutMs));
      }, timeoutMs);

      if (outerSignal) {
        onOuterAbort = () => {
          controller.abort();
          reject(new OperationAbortedError(dependency));
        };
        if (outerSignal.aborted) {
          onOuterAbort();
          return;
        }
        outerSignal.addEventListener('abort', onOuterAbort);
      }

      // Wrapped in Promise.resolve so an operation that throws synchronously
      // rejects this promise rather than escaping the constructor.
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (outerSignal && onOuterAbort) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// Retry with fallback
// ---------------------------------------------------------------------------

export type ResilienceEventType = 'attempt_failed' | 'retrying' | 'recovered' | 'degraded';

export interface ResilienceEvent {
  type: ResilienceEventType;
  dependency: string;
  /** 1-based. */
  attempt: number;
  reason?: DegradeReason;
  detail?: string;
  /** Backoff about to be waited, on a `retrying` event. */
  delayMs?: number;
}

export interface ResilientOptions {
  /** Dependency name. Appears in the notice and in /api/health. */
  dependency: string;
  /** Deadline for one attempt. */
  timeoutMs?: number;
  /** Total attempts including the first. */
  attempts?: number;
  /** First backoff. Doubles each retry, jittered. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Wall-clock ceiling across every attempt and every backoff.
   *
   * The reason this exists separately from attempts * timeoutMs: three attempts
   * at four seconds is a twelve second stall, which no live demo survives. The
   * budget is what actually bounds the user-visible wait.
   */
  budgetMs?: number;
  signal?: AbortSignal;
  /** Return false for an error that will never succeed on retry, e.g. a 401. */
  retryable?: (error: unknown) => boolean;
  /** 0..1. Injectable so a test can assert exact backoff values. */
  jitter?: () => number;
  /** Injectable so a test does not have to wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onEvent?: (event: ResilienceEvent) => void;
}

export interface ResilientResult<T> {
  value: T;
  /** True when `value` came from the fallback. Callers MUST surface this. */
  degraded: boolean;
  source: 'live' | 'fallback';
  /** Attempts actually made against the live path. */
  attempts: number;
  elapsedMs: number;
  /** Present exactly when degraded is true. */
  notice?: DegradedNotice;
}

const DEFAULTS = {
  timeoutMs: 4000,
  attempts: 3,
  backoffMs: 150,
  maxBackoffMs: 2000,
  /** Roughly two attempts plus backoff. Past this the audience has moved on. */
  budgetMs: 8000,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Everything is retryable except a caller abort and an explicitly permanent
 * failure. Deciding retryability from an HTTP status is the caller's job,
 * because only the caller knows what its client throws.
 */
function defaultRetryable(error: unknown): boolean {
  return !(error instanceof OperationAbortedError);
}

function classify(error: unknown): DegradeReason {
  if (error instanceof TimeoutError) return 'timeout';
  if (error instanceof OperationAbortedError) return 'aborted';
  return 'error';
}

/**
 * Run an external call with a deadline, bounded retry, and a degraded fallback.
 *
 * Guarantees:
 *  - It never throws for a failure of `operation`. The only error it can throw
 *    is FallbackFailedError, which means the caller's fallback is broken.
 *  - It settles within roughly `budgetMs`, regardless of `attempts` and
 *    regardless of whether `operation` ever settles.
 *  - Retries back off exponentially with jitter and stop at `attempts`, or
 *    earlier if the remaining budget cannot fit another attempt.
 *  - Every degraded outcome produces a DegradedNotice that is both returned and
 *    recorded in the process-local degradation log, so a degraded path is
 *    always observable.
 *  - `degraded` is false only when a live attempt actually succeeded.
 */
export async function withFallback<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  fallback: (notice: DegradedNotice) => T | Promise<T>,
  options: ResilientOptions,
): Promise<ResilientResult<T>> {
  const {
    dependency,
    timeoutMs = DEFAULTS.timeoutMs,
    attempts: maxAttempts = DEFAULTS.attempts,
    backoffMs = DEFAULTS.backoffMs,
    maxBackoffMs = DEFAULTS.maxBackoffMs,
    budgetMs = DEFAULTS.budgetMs,
    signal,
    retryable = defaultRetryable,
    jitter = Math.random,
    sleep = defaultSleep,
    now = Date.now,
    onEvent,
  } = options;

  const start = now();
  const elapsed = (): number => now() - start;
  const emit = (event: ResilienceEvent): void => {
    // An observer that throws must not take down the call it is observing.
    try {
      onEvent?.(event);
    } catch {
      /* ignore */
    }
  };

  let used = 0;
  let reason: DegradeReason = 'error';
  let detail = 'no attempt was made';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      reason = 'aborted';
      detail = 'caller aborted before the attempt started';
      break;
    }

    const remaining = budgetMs - elapsed();
    if (remaining <= 0) {
      reason = 'budget_exhausted';
      detail = `exceeded the ${budgetMs}ms budget after ${used} attempt(s)`;
      break;
    }

    used = attempt;
    try {
      // The attempt deadline is clamped to the remaining budget, so the last
      // attempt cannot overrun the ceiling the caller was promised.
      const value = await withTimeout(
        operation,
        Math.min(timeoutMs, remaining),
        dependency,
        signal,
      );
      if (attempt > 1) {
        emit({ type: 'recovered', dependency, attempt });
      }
      return { value, degraded: false, source: 'live', attempts: attempt, elapsedMs: elapsed() };
    } catch (error) {
      reason = classify(error);
      detail = describeError(error);
      emit({ type: 'attempt_failed', dependency, attempt, reason, detail });

      if (reason === 'aborted') break;
      if (!retryable(error)) break;
      if (attempt === maxAttempts) break;

      // Exponential with jitter. Jitter is not cosmetic here: four surfaces
      // retrying the same dead gateway in lockstep is a self-inflicted spike at
      // the exact moment the network is already struggling.
      const base = Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs);
      const delayMs = Math.round(base * (0.5 + 0.5 * jitter()));

      // Do not sleep into the budget just to time out immediately afterwards.
      if (delayMs + elapsed() >= budgetMs) {
        reason = 'budget_exhausted';
        detail = `no budget left for a retry after ${used} attempt(s)`;
        break;
      }

      emit({ type: 'retrying', dependency, attempt, reason, detail, delayMs });
      await sleep(delayMs);
    }
  }

  const notice = recordDegradation({
    dependency,
    reason,
    detail,
    attempts: used,
    at: new Date().toISOString(),
  });
  emit({ type: 'degraded', dependency, attempt: used, reason, detail });

  let value: T;
  try {
    value = await fallback(notice);
  } catch (error) {
    throw new FallbackFailedError(dependency, notice, error);
  }

  return {
    value,
    degraded: true,
    source: 'fallback',
    attempts: used,
    elapsedMs: elapsed(),
    notice,
  };
}

/**
 * A notice for a dependency that was never configured.
 *
 * Guarantees: recorded in the degradation log like any other notice, so "we are
 * running without a Places key" is visible in the same place as "Places timed
 * out". A missing key and a dead network produce the same user experience and
 * should not require two different places to look.
 */
export function notConfiguredNotice(dependency: string, detail: string): DegradedNotice {
  return recordDegradation({
    dependency,
    reason: 'not_configured',
    detail: redactSafe(detail),
    attempts: 0,
    at: new Date().toISOString(),
  });
}

/** Local so callers do not have to import the redactor to build a notice. */
function redactSafe(detail: string): string {
  return describeError(detail);
}

export const __testing = { DEFAULTS, classify, defaultRetryable };
