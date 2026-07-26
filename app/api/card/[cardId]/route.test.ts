/**
 * /api/card/[cardId] tests. Track C.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';
import { POST as createCard } from '../create/route';
import { rateLimitKey } from '@/lib/api/identity';
import { LIMITS, resetRateLimits, takeToken } from '@/lib/api/rate-limit';
import { resetStoreForTests } from '@/lib/store/memory';

function params(cardId: string): { params: Promise<{ cardId: string }> } {
  return { params: Promise.resolve({ cardId }) };
}

beforeEach(() => {
  resetStoreForTests();
  resetRateLimits();
});

async function makeCard(): Promise<string> {
  const res = await createCard(
    new Request('http://localhost/api/card/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev50001', dishA: 'd1', dishB: 'd2', winner: 'd1' }),
    }),
  );
  const card = (await res.json()) as { cardId: string };
  return card.cardId;
}

describe('reading a card', () => {
  it('is reachable with no identity at all, matching a first-time link tap', async () => {
    const cardId = await makeCard();
    const res = await GET(new Request(`http://localhost/api/card/${cardId}`), params(cardId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      card: { cardId: string; a: { dishId: string } };
      senderPickedDishId: string | null;
    };
    expect(body.card.cardId).toBe(cardId);
    expect(body.senderPickedDishId).toBe('d1');
  });

  it('returns 404 for an unknown card id', async () => {
    const res = await GET(
      new Request('http://localhost/api/card/zzzzz'),
      params('zzzzz'),
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed card id rather than looking it up', async () => {
    const res = await GET(
      new Request('http://localhost/api/card/../../etc'),
      params('../../etc'),
    );
    expect(res.status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the read bucket for this address is spent', async () => {
    const cardId = await makeCard();
    // No identity on a read: the key is address-based (identity: null), same
    // as what the route computes for an unauthenticated GET.
    const key = rateLimitKey('card/read', new Request('http://localhost/api/card/x'), null);
    for (let i = 0; i < LIMITS.cardRead.capacity; i++) takeToken(key, LIMITS.cardRead);

    const res = await GET(new Request(`http://localhost/api/card/${cardId}`), params(cardId));
    expect(res.status).toBe(429);
  });
});
