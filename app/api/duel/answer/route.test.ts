/**
 * /api/duel/answer tests. Track C.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { resolveIdentity, rateLimitKey } from '@/lib/api/identity';
import { LIMITS, resetRateLimits, takeToken } from '@/lib/api/rate-limit';
import { resetStoreForTests } from '@/lib/store/memory';

function req(body: unknown): Request {
  return new Request('http://localhost/api/duel/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStoreForTests();
  resetRateLimits();
});

describe('recording a duel', () => {
  it('fits a theta from one verified duel for a device with no account', async () => {
    const res = await POST(
      req({ deviceId: 'dev10001', dishA: 'd1', dishB: 'd2', winner: 'd1', surface: 'demo' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userVector: { theta: number[]; nComparisons: number };
      thetaStable: boolean;
    };
    expect(body.userVector.nComparisons).toBe(1);
    expect(body.userVector.theta).toHaveLength(24);
    // One duel is nowhere near MIN_DUELS_FOR_THETA.
    expect(body.thetaStable).toBe(false);
  });

  it('accumulates across repeated calls for the same device', async () => {
    await POST(req({ deviceId: 'dev10002', dishA: 'd1', dishB: 'd2', winner: 'd1', surface: 'demo' }));
    const res = await POST(
      req({ deviceId: 'dev10002', dishA: 'd3', dishB: 'd4', winner: 'd4', surface: 'demo' }),
    );
    const body = (await res.json()) as { userVector: { nComparisons: number } };
    expect(body.userVector.nComparisons).toBe(2);
  });
});

describe('validation', () => {
  it('rejects a winner that is neither dishA nor dishB', async () => {
    const res = await POST(
      req({ deviceId: 'dev10003', dishA: 'd1', dishB: 'd2', winner: 'd3', surface: 'demo' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(body.error.field).toBe('winner');
  });

  it('rejects dishA equal to dishB', async () => {
    const res = await POST(
      req({ deviceId: 'dev10004', dishA: 'd1', dishB: 'd1', winner: 'd1', surface: 'demo' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a dish id this corpus does not have', async () => {
    const res = await POST(
      req({ deviceId: 'dev10005', dishA: 'd1', dishB: 'd_nonexistent', winner: 'd1', surface: 'demo' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a surface outside the closed set', async () => {
    const res = await POST(
      req({ deviceId: 'dev10006', dishA: 'd1', dishB: 'd2', winner: 'd1', surface: 'carrier-pigeon' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a missing deviceId with a typed error, never a raw throw', async () => {
    const res = await POST(req({ dishA: 'd1', dishB: 'd2', winner: 'd1', surface: 'demo' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });
});

describe('rate limiting', () => {
  it('returns 429 once the bucket for a device is spent', async () => {
    const deviceId = 'dev10007';
    // Pre-spend the bucket directly rather than looping the real route:
    // recordDuel refits theta on every call, and under full-suite CPU
    // contention 61 real fits took long enough in wall-clock time for the
    // bucket to partially refill (refillPerSecond: 1), making the loop flaky.
    // takeToken is the exact function enforceRateLimit calls, so spending the
    // same key here is equivalent and instantaneous.
    const identity = resolveIdentity({ deviceId });
    const key = rateLimitKey('duel/answer', req({}), identity);
    for (let i = 0; i < LIMITS.duelAnswer.capacity; i++) takeToken(key, LIMITS.duelAnswer);

    const res = await POST(req({ deviceId, dishA: 'd1', dishB: 'd2', winner: 'd1', surface: 'demo' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});
