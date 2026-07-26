/**
 * /api/duel/next tests. Track C.
 *
 * Exercises the exported POST handler directly with real Request objects, no
 * network and no database: the whole point of the in-memory store.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { POST as answerDuel } from '../answer/route';
import { resolveIdentity, rateLimitKey } from '@/lib/api/identity';
import { LIMITS, resetRateLimits, takeToken } from '@/lib/api/rate-limit';
import { resetStoreForTests } from '@/lib/store/memory';

function req(body: unknown): Request {
  return new Request('http://localhost/api/duel/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStoreForTests();
  resetRateLimits();
});

describe('the device-only path', () => {
  it('returns duel pairs for a device with no userId at all', async () => {
    const res = await POST(req({ deviceId: 'dev00001' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairs: Array<{ pairId: string; a: unknown; b: unknown }> };
    expect(Array.isArray(body.pairs)).toBe(true);
    expect(body.pairs.length).toBeGreaterThan(0);
    for (const p of body.pairs) {
      expect(p.pairId).toBeTruthy();
      expect(p.a).toBeTruthy();
      expect(p.b).toBeTruthy();
    }
  });

  it('never repeats a dish the device has already been shown', async () => {
    const first = await POST(req({ deviceId: 'dev00002', count: 8 }));
    const firstBody = (await first.json()) as {
      pairs: Array<{ a: { dishId: string }; b: { dishId: string } }>;
    };
    // Answer every pair from the first block so those dishes enter seenDishIds.
    for (const p of firstBody.pairs) {
      await answerDuel(
        new Request('http://localhost/api/duel/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            deviceId: 'dev00002',
            dishA: p.a.dishId,
            dishB: p.b.dishId,
            winner: p.a.dishId,
            surface: 'demo',
          }),
        }),
      );
    }

    const seen = new Set(firstBody.pairs.flatMap((p) => [p.a.dishId, p.b.dishId]));
    const second = await POST(req({ deviceId: 'dev00002', count: 8 }));
    const secondBody = (await second.json()) as {
      pairs: Array<{ a: { dishId: string }; b: { dishId: string } }>;
    };
    for (const p of secondBody.pairs) {
      expect(seen.has(p.a.dishId)).toBe(false);
      expect(seen.has(p.b.dishId)).toBe(false);
    }
  });
});

describe('validation', () => {
  it('rejects a body with no deviceId', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });

  it('rejects a deviceId with disallowed characters', async () => {
    const res = await POST(req({ deviceId: 'not a valid id!' }));
    expect(res.status).toBe(400);
  });

  it('never throws a raw error for a malformed JSON body', async () => {
    const res = await POST(
      new Request('http://localhost/api/duel/next', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });
});

function spendBucket(route: string, deviceId: string, capacity: number, config: { capacity: number; refillPerSecond: number }): void {
  const identity = resolveIdentity({ deviceId });
  const key = rateLimitKey(route, req({}), identity);
  for (let i = 0; i < capacity; i++) takeToken(key, config);
}

describe('rate limiting', () => {
  it('returns 429 with a Retry-After header once the bucket is spent', async () => {
    const deviceId = 'dev00003';
    // Pre-spend the bucket directly: selectDuels runs a real sampled search
    // over the corpus on every call, and looping the live route enough times
    // to exhaust a 30-token bucket is slow enough under full-suite load that
    // the bucket partially refills before the last call lands. takeToken is
    // exactly what enforceRateLimit calls, so this is equivalent and instant.
    spendBucket('duel/next', deviceId, LIMITS.duelNext.capacity, LIMITS.duelNext);

    const res = await POST(req({ deviceId, count: 1 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
  });

  it('keys the bucket per device, so a second device is unaffected', async () => {
    spendBucket('duel/next', 'dev00004', LIMITS.duelNext.capacity, LIMITS.duelNext);
    const res = await POST(req({ deviceId: 'dev00005', count: 1 }));
    expect(res.status).toBe(200);
  });
});
