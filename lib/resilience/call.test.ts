/**
 * Tests for the external-call wrapper. Track C.
 *
 * The property under test in every case below is the one the demo actually
 * depends on: a hung operation must still produce a response, and that
 * response must say plainly that it came from the fallback rather than the
 * live path.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FallbackFailedError,
  OperationAbortedError,
  TimeoutError,
  withFallback,
  withTimeout,
} from './call';
import { clearDegradations, recentDegradations } from './degradation';

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* deliberately never resolves or rejects */
  });
}

describe('withTimeout', () => {
  it('resolves normally when the operation finishes inside the deadline', async () => {
    const value = await withTimeout(async () => 'ok', 50, 'quick-dep');
    expect(value).toBe('ok');
  });

  it('rejects with TimeoutError at the deadline even when the operation never settles', async () => {
    const start = Date.now();
    await expect(withTimeout(() => neverSettles<string>(), 30, 'stuck-dep')).rejects.toBeInstanceOf(TimeoutError);
    // The promise must settle near the deadline, not hang for the test's own timeout.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('aborts the operation signal at the deadline', async () => {
    let observedAborted = false;
    await expect(
      withTimeout((signal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            observedAborted = true;
            reject(new Error('cancelled'));
          });
        });
      }, 20, 'signalled-dep'),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(observedAborted).toBe(true);
  });
});

describe('withFallback: timeout returns the fallback rather than throwing', () => {
  it('never throws for an operation that always times out', async () => {
    const result = await withFallback<string>(
      () => neverSettles<string>(),
      () => 'fallback-value',
      { dependency: 'hung-dep', timeoutMs: 20, attempts: 1, budgetMs: 200 },
    );

    expect(result.degraded).toBe(true);
    expect(result.source).toBe('fallback');
    expect(result.value).toBe('fallback-value');
    expect(result.notice?.reason).toBe('timeout');
    expect(result.notice?.dependency).toBe('hung-dep');
  });
});

describe('withFallback: retry backoff', () => {
  it('backs off exponentially with jitter and stops at the attempt ceiling', async () => {
    let calls = 0;
    const sleeps: number[] = [];

    const result = await withFallback<string>(
      async () => {
        calls += 1;
        throw new Error(`attempt ${calls} failed`);
      },
      () => 'fallback-value',
      {
        dependency: 'flaky-dep',
        timeoutMs: 1000,
        attempts: 3,
        backoffMs: 100,
        maxBackoffMs: 2000,
        budgetMs: 10_000,
        jitter: () => 0.5, // fixed midpoint jitter for a deterministic delay
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    // Exactly three attempts against the live path: the ceiling, not one more.
    expect(calls).toBe(3);
    // Backoff happens between attempts only, never after the last one.
    expect(sleeps).toHaveLength(2);
    // base = backoffMs * 2^(attempt-1), delay = round(base * (0.5 + 0.5*jitter())).
    // jitter fixed at 0.5 makes the multiplier exactly 0.75.
    expect(sleeps[0]).toBe(Math.round(100 * 0.75));
    expect(sleeps[1]).toBe(Math.round(200 * 0.75));
    expect(result.degraded).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('does not retry a caller abort', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const result = await withFallback<string>(
      async () => {
        calls += 1;
        throw new OperationAbortedError('aborted-dep');
      },
      () => 'fallback-value',
      { dependency: 'aborted-dep', attempts: 5, signal: controller.signal, budgetMs: 5000 },
    );

    expect(calls).toBe(0);
    expect(result.notice?.reason).toBe('aborted');
  });

  it('stops early when the budget cannot fit another attempt, even under the attempt ceiling', async () => {
    let calls = 0;
    const result = await withFallback<string>(
      async () => {
        calls += 1;
        throw new Error('down');
      },
      () => 'fallback-value',
      {
        dependency: 'budget-dep',
        attempts: 10,
        timeoutMs: 1000,
        backoffMs: 1000,
        budgetMs: 50,
        sleep: async () => {},
      },
    );

    expect(calls).toBeLessThan(10);
    expect(result.notice?.reason).toBe('budget_exhausted');
  });
});

describe('withFallback: success path', () => {
  it('reports degraded: false and never calls the fallback when the live call succeeds', async () => {
    const fallback = vi.fn(() => 'should-not-be-used');
    const result = await withFallback<string>(async () => 'live-value', fallback, {
      dependency: 'healthy-dep',
    });

    expect(result.degraded).toBe(false);
    expect(result.source).toBe('live');
    expect(result.value).toBe('live-value');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('recovers after a retry and reports the successful attempt count', async () => {
    let calls = 0;
    const result = await withFallback<string>(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('flaky once');
        return 'recovered';
      },
      () => 'fallback-value',
      { dependency: 'recovering-dep', attempts: 3, sleep: async () => {} },
    );

    expect(result.degraded).toBe(false);
    expect(result.value).toBe('recovered');
    expect(result.attempts).toBe(2);
  });
});

describe('withFallback: a broken fallback is loud, not silent', () => {
  it('throws FallbackFailedError when the fallback itself throws', async () => {
    await expect(
      withFallback<string>(
        () => neverSettles<string>(),
        () => {
          throw new Error('fallback is broken');
        },
        { dependency: 'double-broken-dep', timeoutMs: 10, attempts: 1, budgetMs: 100 },
      ),
    ).rejects.toBeInstanceOf(FallbackFailedError);
  });
});

describe('degradation observability', () => {
  it('records every degraded outcome so it is visible outside the return value', () => {
    clearDegradations();
    return withFallback<string>(
      () => neverSettles<string>(),
      () => 'fallback-value',
      { dependency: 'observed-dep', timeoutMs: 10, attempts: 1, budgetMs: 100 },
    ).then(() => {
      const notices = recentDegradations();
      expect(notices.length).toBeGreaterThan(0);
      expect(notices[0].dependency).toBe('observed-dep');
      expect(notices[0].reason).toBe('timeout');
    });
  });
});
