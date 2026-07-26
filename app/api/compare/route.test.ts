/**
 * /api/compare tests. Track C.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { POST as createCard } from '../card/create/route';
import { POST as answerDuel } from '../duel/answer/route';
import { resolveIdentity, rateLimitKey } from '@/lib/api/identity';
import { LIMITS, resetRateLimits, takeToken } from '@/lib/api/rate-limit';
import { resetStoreForTests } from '@/lib/store/memory';

function req(body: unknown): Request {
  return new Request('http://localhost/api/compare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStoreForTests();
  resetRateLimits();
});

async function cardFromCreator(deviceId: string): Promise<string> {
  const res = await createCard(
    new Request('http://localhost/api/card/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, dishA: 'd1', dishB: 'd2', winner: 'd1' }),
    }),
  );
  const card = (await res.json()) as { cardId: string };
  return card.cardId;
}

describe('comparing two people through a shared card', () => {
  it('is device-only on both sides: no account anywhere in the exchange', async () => {
    const cardId = await cardFromCreator('dev60001');
    const res = await POST(req({ deviceId: 'dev60002', cardId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comparison: {
        agreementRate: number;
        hardestDivergence: { axis: string; label: string; aValue: number; bValue: number };
        areTwins: boolean;
        verdictText: string;
      };
    };
    const c = body.comparison;
    expect(c.agreementRate).toBeGreaterThanOrEqual(0);
    expect(c.agreementRate).toBeLessThanOrEqual(1);
    expect(typeof c.areTwins).toBe('boolean');
    expect(c.hardestDivergence.axis).toBeTruthy();
    expect(c.verdictText.length).toBeGreaterThan(0);
    // Hard rule 6, and this text is hand-written, never model-generated, so an
    // exclamation point here would be this file's own bug.
    expect(c.verdictText).not.toMatch(/!/);
  });

  it('is honestly defined even when the card creator never played a duel', async () => {
    const cardId = await cardFromCreator('dev60003');
    const res = await POST(req({ deviceId: 'dev60004', cardId }));
    expect(res.status).toBe(200);
  });

  it('stays well defined once both sides have real, distinct duel history', async () => {
    const cardId = await cardFromCreator('dev60005');
    await answerDuel(
      new Request('http://localhost/api/duel/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'dev60005',
          dishA: 'd6',
          dishB: 'd7',
          winner: 'd6',
          surface: 'demo',
        }),
      }),
    );
    await answerDuel(
      new Request('http://localhost/api/duel/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'dev60006',
          dishA: 'd6',
          dishB: 'd7',
          winner: 'd7',
          surface: 'demo',
        }),
      }),
    );
    const res = await POST(req({ deviceId: 'dev60006', cardId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comparison: { agreementRate: number; hardestDivergence: { aValue: number; bValue: number } };
    };
    expect(body.comparison.agreementRate).toBeGreaterThanOrEqual(0);
    expect(body.comparison.agreementRate).toBeLessThanOrEqual(1);
    expect(Number.isFinite(body.comparison.hardestDivergence.aValue)).toBe(true);
    expect(Number.isFinite(body.comparison.hardestDivergence.bValue)).toBe(true);
  });
});

describe('validation', () => {
  it('rejects a request with no cardId', async () => {
    const res = await POST(req({ deviceId: 'dev60007' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 for a cardId nobody created', async () => {
    const res = await POST(req({ deviceId: 'dev60008', cardId: 'zzzzz' }));
    expect(res.status).toBe(404);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the compare bucket for a device is spent', async () => {
    const cardId = await cardFromCreator('dev60009');
    const deviceId = 'dev60010';
    const identity = resolveIdentity({ deviceId });
    const key = rateLimitKey('compare', req({}), identity);
    for (let i = 0; i < LIMITS.compare.capacity; i++) takeToken(key, LIMITS.compare);

    const res = await POST(req({ deviceId, cardId }));
    expect(res.status).toBe(429);
  });
});
