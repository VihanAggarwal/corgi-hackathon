/**
 * POST /api/enterprise/dinner tests. Track C.
 *
 * This is the HTTP boundary, so the questions worth asking here are different
 * from lib/enterprise/dinner.test.ts: does a malformed request come back as a
 * typed 400 instead of a stack, does the response body ever carry a
 * constraint value, and does the route still work with no credentials at all,
 * which is the state this whole repo is in today.
 *
 * lib/enterprise/dishes, lib/enterprise/members and lib/enterprise/org are
 * mocked here because the route builds its own dependencies internally rather
 * than accepting them as parameters (planTeamDinner does, and that seam is
 * exercised directly in lib/enterprise/dinner.test.ts). The HRIS provider is
 * NOT mocked at the module level: registerHrisProvider is the real, public
 * seam integrations/hris/provider.ts offers for exactly this purpose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/enterprise/dishes', () => ({
  defaultDinnerDishSource: vi.fn(),
}));
vi.mock('@/lib/enterprise/members', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/enterprise/members')>();
  return { ...actual, defaultOrgMemberSource: vi.fn() };
});
vi.mock('@/lib/enterprise/org', () => ({
  defaultOrgAccountToken: vi.fn(async () => null),
}));

import { POST } from './route';
import { defaultDinnerDishSource } from '@/lib/enterprise/dishes';
import { defaultOrgMemberSource, inMemoryOrgMemberSource, type OrgMembership } from '@/lib/enterprise/members';
import { inMemoryDishSource, type DinnerDish } from '@/lib/enterprise/dinner';
import { resetRateLimits } from '@/lib/api/rate-limit';
import {
  registerHrisProvider,
  resetHrisProviders,
  type HrisProvider,
} from '@/integrations/hris/provider';
import { AXIS_COUNT } from '@/contracts/axes';
import type { Vec24 } from '@/contracts/types';

function vec(index: number, value: number): Vec24 {
  const v = new Array<number>(AXIS_COUNT).fill(0);
  v[index] = value;
  return v;
}

const VALID_BODY = {
  orgId: 'org1',
  attendeeUserIds: ['u1', 'u2'],
  partySize: 4,
  lat: 40.73,
  lng: -73.99,
  radiusM: 2000,
  maxPerHeadCents: null,
  windowStart: '2026-08-01T19:00:00.000Z',
};

function postJson(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/enterprise/dinner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  resetRateLimits();
  resetHrisProviders();
  vi.mocked(defaultDinnerDishSource).mockReturnValue({ async candidatesForDinner() { return []; } });
  vi.mocked(defaultOrgMemberSource).mockReturnValue(inMemoryOrgMemberSource([]));
});

afterEach(() => {
  resetRateLimits();
  resetHrisProviders();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Works with no credentials at all
// ---------------------------------------------------------------------------

describe('with no credentials configured', () => {
  it('plans an honest, empty dinner rather than throwing', async () => {
    const response = await POST(postJson(VALID_BODY));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body).toEqual({ candidates: [], constraintsAppliedCount: 0 });
  });

  it('sets no-store on the response', async () => {
    const response = await POST(postJson(VALID_BODY));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('rejects a non-JSON body with invalid_body, not a 500', async () => {
    const request = new Request('http://localhost/api/enterprise/dinner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    expect((body.error as { code: string }).code).toBe('invalid_body');
  });

  it('rejects a request missing required fields, reporting the field problems', async () => {
    const response = await POST(postJson({ orgId: 'org1' }));
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    const error = body.error as { code: string; message: string };
    expect(error.code).toBe('invalid_body');
    expect(error.message).toMatch(/attendeeUserIds/);
  });

  it('rejects an out-of-range coordinate', async () => {
    const response = await POST(postJson({ ...VALID_BODY, lat: 999 }));
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('returns 429 with a Retry-After header once the bucket is spent', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 20; i++) {
      last = await POST(postJson(VALID_BODY));
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBeTruthy();
    const body = await bodyOf(last!);
    expect((body.error as { code: string }).code).toBe('rate_limited');
  });
});

// ---------------------------------------------------------------------------
// The privacy boundary, exercised through the real HTTP surface
// ---------------------------------------------------------------------------

describe('constraint disclosure over HTTP', () => {
  const MENU: DinnerDish[] = [
    {
      id: 'd1', name: 'Liang pi', description: 'Cold wheat noodles, chili oil',
      venueId: 'v1', venueName: 'Hunan Slurp', neighborhood: 'East Village',
      lat: VALID_BODY.lat, lng: VALID_BODY.lng, priceCents: 1400, phi: vec(0, 2),
    },
    {
      id: 'd2', name: 'Pork belly bun', description: 'Braised pork belly',
      venueId: 'v2', venueName: 'Kopitiam', neighborhood: 'Chinatown',
      lat: VALID_BODY.lat, lng: VALID_BODY.lng, priceCents: 900, phi: vec(0, 1),
    },
    {
      id: 'd3', name: 'Shrimp toast', description: 'Fried shrimp paste on brioche',
      venueId: 'v2', venueName: 'Kopitiam', neighborhood: 'Chinatown',
      lat: VALID_BODY.lat, lng: VALID_BODY.lng, priceCents: 1000, phi: vec(0, 0.5),
    },
    {
      id: 'd4', name: 'Peanut noodles', description: 'Sesame and peanut butter sauce',
      venueId: 'v3', venueName: 'Noodle House', neighborhood: 'Chinatown',
      lat: VALID_BODY.lat, lng: VALID_BODY.lng, priceCents: 800, phi: vec(0, 0.3),
    },
  ];

  const MEMBERSHIPS: OrgMembership[] = [
    { userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' },
    { userId: 'u2', consentedAt: '2026-01-01T00:00:00Z' },
  ];

  /**
   * Answers with a fixed row set per user, INCLUDING one for u3, who is never
   * consented in these tests. A provider that gets asked about u3 would apply
   * it; this fixture proves the route never asks.
   */
  function fixtureHrisProvider(): HrisProvider {
    return {
      id: 'fixture',
      isAvailable: () => true,
      async constraintsForOrg(request) {
        const rows = [
          { userId: 'u1', kind: 'religious', value: 'kosher', consentedAt: 'x' },
          { userId: 'u1', kind: 'allergy', value: 'no cilantro', consentedAt: 'x' },
          { userId: 'u2', kind: 'dietary', value: 'vegetarian', consentedAt: 'x' },
          { userId: 'u2', kind: 'allergy', value: 'shellfish allergy', consentedAt: 'x' },
          { userId: 'u3', kind: 'allergy', value: 'peanut allergy', consentedAt: 'x' },
        ];
        const wanted = new Set(request.subjects.map((s) => s.userId));
        return rows.filter((r) => wanted.has(r.userId));
      },
    };
  }

  beforeEach(() => {
    vi.mocked(defaultDinnerDishSource).mockReturnValue(inMemoryDishSource(MENU));
    vi.mocked(defaultOrgMemberSource).mockReturnValue(inMemoryOrgMemberSource(MEMBERSHIPS));
    registerHrisProvider(fixtureHrisProvider());
  });

  it('reports four constraints applied and discloses none of them in the response body', async () => {
    const response = await POST(postJson({ ...VALID_BODY, attendeeUserIds: ['u1', 'u2'] }));
    expect(response.status).toBe(200);

    const raw = await response.text();
    // "peanut" is deliberately not checked: "Peanut noodles" is a menu name
    // that survives this filter and may legitimately appear in a rendered
    // recommendation. Article 9 vocabulary is what must never appear, not
    // every word a constraint value happens to share with a dish name.
    expect(raw).not.toMatch(/kosher|vegetarian|cilantro|shellfish|religious|dietary|allergy/i);
    expect(raw).not.toContain('"u1"');
    expect(raw).not.toContain('"u2"');

    const body = JSON.parse(raw) as { candidates: unknown[]; constraintsAppliedCount: number };
    expect(body.constraintsAppliedCount).toBe(4);
    expect(Object.keys(body).sort()).toEqual(['candidates', 'constraintsAppliedCount']);
  });

  it('excludes an attendee with no consent even when the roster and the HRIS both have a record for them', async () => {
    const unconsented: OrgMembership[] = [...MEMBERSHIPS, { userId: 'u3', consentedAt: null }];
    vi.mocked(defaultOrgMemberSource).mockReturnValue(inMemoryOrgMemberSource(unconsented));

    const response = await POST(postJson({ ...VALID_BODY, attendeeUserIds: ['u1', 'u2', 'u3'] }));
    const body = (await response.json()) as {
      candidates: Array<{ dishIds: string[] }>;
      constraintsAppliedCount: number;
    };

    // Still four: u1 and u2's rows, never u3's, even though the fixture would
    // have handed back a peanut-allergy row for u3 if it had ever been asked.
    expect(body.constraintsAppliedCount).toBe(4);

    // The peanut noodles survive, which is only possible if u3's on-file
    // allergy was never applied.
    const dishIds = body.candidates.flatMap((c) => c.dishIds);
    expect(dishIds).toContain('d4');
  });
});
