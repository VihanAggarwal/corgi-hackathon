/**
 * /api/card/create tests. Track C.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { resolveIdentity, rateLimitKey } from '@/lib/api/identity';
import { LIMITS, resetRateLimits, takeToken } from '@/lib/api/rate-limit';
import { resetStoreForTests } from '@/lib/store/memory';

function req(body: unknown): Request {
  return new Request('http://localhost/api/card/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStoreForTests();
  resetRateLimits();
});

describe('creating a card', () => {
  it('returns a DuelCard with a shareUrl a device with no account can create', async () => {
    const res = await POST(req({ deviceId: 'dev40001', dishA: 'd1', dishB: 'd2', winner: 'd1' }));
    expect(res.status).toBe(201);
    const card = (await res.json()) as {
      cardId: string;
      a: { dishId: string; name: string };
      b: { dishId: string; name: string };
      shareUrl: string;
    };
    expect(card.cardId).toBeTruthy();
    expect(card.a.dishId).toBe('d1');
    expect(card.b.dishId).toBe('d2');
    expect(card.shareUrl).toBe(`/c/${card.cardId}`);
  });

  it('produces a different cardId on every call', async () => {
    const first = await POST(req({ deviceId: 'dev40002', dishA: 'd1', dishB: 'd2' }));
    const second = await POST(req({ deviceId: 'dev40002', dishA: 'd1', dishB: 'd2' }));
    const a = (await first.json()) as { cardId: string };
    const b = (await second.json()) as { cardId: string };
    expect(a.cardId).not.toBe(b.cardId);
  });
});

describe('validation', () => {
  it('rejects dishA equal to dishB', async () => {
    const res = await POST(req({ deviceId: 'dev40003', dishA: 'd1', dishB: 'd1' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown dish id', async () => {
    const res = await POST(req({ deviceId: 'dev40004', dishA: 'd1', dishB: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('rejects a winner that is neither dishA nor dishB', async () => {
    const res = await POST(req({ deviceId: 'dev40005', dishA: 'd1', dishB: 'd2', winner: 'd3' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing deviceId', async () => {
    const res = await POST(req({ dishA: 'd1', dishB: 'd2' }));
    expect(res.status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the card creation bucket is spent', async () => {
    const deviceId = 'dev40006';
    const identity = resolveIdentity({ deviceId });
    const key = rateLimitKey('card/create', req({}), identity);
    for (let i = 0; i < LIMITS.cardCreate.capacity; i++) takeToken(key, LIMITS.cardCreate);

    const res = await POST(req({ deviceId, dishA: 'd1', dishB: 'd2' }));
    expect(res.status).toBe(429);
  });
});
