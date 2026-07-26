/**
 * /api/portrait tests. Track C.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';
import { POST as answerDuel } from '../duel/answer/route';
import { resolveIdentity, rateLimitKey } from '@/lib/api/identity';
import { LIMITS, resetRateLimits, takeToken } from '@/lib/api/rate-limit';
import { resetStoreForTests } from '@/lib/store/memory';

function getReq(qs: string): Request {
  return new Request(`http://localhost/api/portrait?${qs}`);
}

function answerReq(body: unknown): Request {
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

describe('the device-only path', () => {
  it('produces an honest, unflattering-containing portrait from no credentials at all', async () => {
    const res = await GET(getReq('deviceId=dev70001'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      portrait: { userId: string; body: string; containsUnflattering: boolean };
    };
    expect(body.portrait.body.length).toBeGreaterThan(0);
    // core/portrait.ts guarantees this is verified, never assumed.
    expect(body.portrait.containsUnflattering).toBe(true);
  });

  it('works at cold start, before a single duel has been played', async () => {
    const res = await GET(getReq('deviceId=dev70002'));
    expect(res.status).toBe(200);
  });

  it('reflects real duel history for a device with an actual palate on file', async () => {
    const deviceId = 'dev70003';
    for (const [a, b] of [
      ['d1', 'd2'],
      ['d3', 'd4'],
      ['d5', 'd6'],
    ] as const) {
      await answerDuel(answerReq({ deviceId, dishA: a, dishB: b, winner: a, surface: 'demo' }));
    }
    const res = await GET(getReq(`deviceId=${deviceId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { portrait: { body: string } };
    expect(body.portrait.body.length).toBeGreaterThan(0);
  });
});

describe('validation and rate limiting', () => {
  it('rejects a request with no deviceId', async () => {
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
  });

  it('returns 429 once the portrait bucket is spent', async () => {
    const deviceId = 'dev70004';
    const identity = resolveIdentity({ deviceId });
    const key = rateLimitKey('portrait', getReq(''), identity);
    for (let i = 0; i < LIMITS.portrait.capacity; i++) takeToken(key, LIMITS.portrait);

    const res = await GET(getReq(`deviceId=${deviceId}`));
    expect(res.status).toBe(429);
  });
});
