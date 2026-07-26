/**
 * /api/profile tests. Track C.
 *
 * The load-bearing assertion in this file is the twins-disabled case: the
 * response must contain nothing a client could render as twin language, not
 * "the enabled flag is false while a descriptor rides along unused".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';
import { POST as answerDuel } from '../duel/answer/route';
import { resolveIdentity, rateLimitKey } from '@/lib/api/identity';
import { LIMITS, resetRateLimits, takeToken } from '@/lib/api/rate-limit';
import { resetStoreForTests } from '@/lib/store/memory';

function getReq(qs: string): Request {
  return new Request(`http://localhost/api/profile?${qs}`);
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
  it('returns a coherent, unformed profile for a brand new device', async () => {
    const res = await GET(getReq('deviceId=dev20001'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userVector: { theta: number[]; nComparisons: number };
      twinStatus: { enabled: boolean; twinCount: number; reason?: string };
      region: { volume: number; exploredAxes: string[]; frontierAxes: string[] };
    };
    expect(body.userVector.theta).toHaveLength(24);
    expect(body.userVector.nComparisons).toBe(0);
    expect(body.twinStatus.enabled).toBe(false);
    expect(body.region.volume).toBe(0);
  });
});

describe('hard rule 5: twins disabled means no twin language at all', () => {
  it('carries no clusterDescriptor, cosine, reliability, weight, or twin identity', async () => {
    const res = await GET(getReq('deviceId=dev20002'));
    const raw = await res.text();

    // Structural check, not a string search alone: the response must not even
    // HAVE a field shaped like a twin claim.
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.twinStatus).toBeDefined();
    expect((body.twinStatus as Record<string, unknown>).enabled).toBe(false);
    expect('clusterDescriptor' in (body.twinStatus as object)).toBe(false);

    // Belt and suspenders: none of the internal-only vocabulary from
    // core/twins.ts (reliability, cosine, weight, twinUserId) appears anywhere
    // in the serialized payload.
    for (const forbidden of ['clusterDescriptor', 'cosine', 'reliability', 'weight', 'twinUserId']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('still reports enabled: false after a handful of duels below the twin floor', async () => {
    const deviceId = 'dev20003';
    const pairs: Array<[string, string]> = [
      ['d1', 'd2'],
      ['d3', 'd4'],
      ['d5', 'd6'],
    ];
    for (const [a, b] of pairs) {
      await answerDuel(
        answerReq({ deviceId, dishA: a, dishB: b, winner: a, surface: 'demo' }),
      );
    }
    const res = await GET(getReq(`deviceId=${deviceId}`));
    const body = (await res.json()) as { twinStatus: { enabled: boolean; reason?: string } };
    expect(body.twinStatus.enabled).toBe(false);
    expect(body.twinStatus.reason).toBe('need_more_duels');
  });
});

describe('validation and rate limiting', () => {
  it('rejects a request with no deviceId in the query', async () => {
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
  });

  it('returns 429 once the bucket is spent', async () => {
    const deviceId = 'dev20004';
    // Pre-spend directly. See app/api/duel/next/route.test.ts for why looping
    // the live route N+1 times is not reliable under full-suite CPU load.
    const identity = resolveIdentity({ deviceId });
    const key = rateLimitKey('profile', getReq(''), identity);
    for (let i = 0; i < LIMITS.profile.capacity; i++) takeToken(key, LIMITS.profile);

    const res = await GET(getReq(`deviceId=${deviceId}`));
    expect(res.status).toBe(429);
  });
});
