/**
 * /api/recommend tests. Track C.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { resolveIdentity, rateLimitKey } from '@/lib/api/identity';
import { LIMITS, resetRateLimits, takeToken } from '@/lib/api/rate-limit';
import { resetStoreForTests } from '@/lib/store/memory';

function req(body: unknown): Request {
  return new Request('http://localhost/api/recommend', {
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
  it('renders real recommendations for a device with no account and no key', async () => {
    const res = await POST(req({ deviceId: 'dev30001', count: 2 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recommendations: Array<{ packetId: string; text: string; sourceChannel: string }>;
    };
    expect(body.recommendations.length).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeLessThanOrEqual(2);
    for (const r of body.recommendations) {
      expect(r.text.length).toBeGreaterThan(0);
      // Hard rule 6: no enthusiasm markers. This is the dry-run renderer path
      // (no ANTHROPIC_API_KEY in this environment) and it must still pass its
      // own validator, so a stray exclamation point here is a real bug.
      expect(r.text).not.toMatch(/!/);
      // A single fresh device can never clear the twin floor.
      expect(r.sourceChannel).toBe('content');
      expect(r.packetId).toBeTruthy();
    }
  });

  it('never recommends a dish the device has already duelled', async () => {
    const { POST: answerDuel } = await import('../duel/answer/route');
    await answerDuel(
      new Request('http://localhost/api/duel/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'dev30002',
          dishA: 'd1',
          dishB: 'd2',
          winner: 'd1',
          surface: 'demo',
        }),
      }),
    );
    const res = await POST(req({ deviceId: 'dev30002', count: 5 }));
    const body = (await res.json()) as { recommendations: Array<{ dishId: string | null }> };
    for (const r of body.recommendations) {
      expect(['d1', 'd2']).not.toContain(r.dishId);
    }
  });

  it('clamps an out of range count rather than rejecting the request', async () => {
    const res = await POST(req({ deviceId: 'dev30003', count: 500 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recommendations: unknown[] };
    // boundedInt caps count at 5 for this route.
    expect(body.recommendations.length).toBeLessThanOrEqual(5);
  });
});

describe('validation', () => {
  it('rejects a body with no deviceId', async () => {
    const res = await POST(req({ count: 1 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });
});

describe('rate limiting', () => {
  it('returns 429 once the recommend bucket for a device is spent', async () => {
    const deviceId = 'dev30004';
    // Pre-spend directly: this route is the single most expensive call in the
    // track (rank, build a packet, render), so looping the live route past a
    // capacity of 8 to force a 429 is both slow and, under full-suite load,
    // exactly the kind of wall-clock delay that lets the bucket refill.
    const identity = resolveIdentity({ deviceId });
    const key = rateLimitKey('recommend', req({}), identity);
    for (let i = 0; i < LIMITS.recommend.capacity; i++) takeToken(key, LIMITS.recommend);

    const res = await POST(req({ deviceId, count: 1 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});
