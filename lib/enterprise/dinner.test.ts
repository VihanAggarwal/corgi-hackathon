/**
 * Team dinner planner tests. Track C.
 *
 * The order-of-operations guarantee in lib/enterprise/dinner.ts is the whole
 * feature, so these tests are built around it rather than around individual
 * helpers: consent gates who is even asked about, the constraint filter runs
 * before ranking and before any render, and the only thing that leaves is an
 * integer count. Every constraint value used in the fixtures below appears
 * only to prove it does NOT appear in the result, or never reaches the model.
 */

import { describe, expect, it, vi } from 'vitest';
import { AXIS_COUNT } from '../../contracts/axes';
import type { EnterpriseDinnerRequest, Vec24 } from '../../contracts/types';
import type { GenerateRequest } from '../../core';
import {
  DinnerRequestError,
  fixedGroupTaste,
  inMemoryDishSource,
  planTeamDinner,
  validateDinnerRequest,
  type DinnerDish,
} from './dinner';
import { inMemoryOrgMemberSource, type OrgMembership } from './members';
import type { HrisFetchRequest, HrisProvider } from '../../integrations/hris/provider';

function vec(index: number, value: number): Vec24 {
  const v = new Array<number>(AXIS_COUNT).fill(0);
  v[index] = value;
  return v;
}

const REQUEST: EnterpriseDinnerRequest = {
  orgId: 'org1',
  attendeeUserIds: ['u1', 'u2', 'u3'],
  partySize: 6,
  lat: 40.73,
  lng: -73.99,
  radiusM: 2000,
  maxPerHeadCents: null,
  windowStart: '2026-08-01T19:00:00.000Z',
};

const MENU: DinnerDish[] = [
  {
    id: 'd1',
    name: 'Liang pi',
    description: 'Cold wheat noodles, chili oil',
    venueId: 'v1',
    venueName: 'Hunan Slurp',
    neighborhood: 'East Village',
    lat: REQUEST.lat,
    lng: REQUEST.lng,
    priceCents: 1400,
    phi: vec(0, 2),
  },
  {
    id: 'd2',
    name: 'Pork belly bun',
    description: 'Braised pork belly, pickled mustard green',
    venueId: 'v2',
    venueName: 'Kopitiam',
    neighborhood: 'Chinatown',
    lat: REQUEST.lat,
    lng: REQUEST.lng,
    priceCents: 900,
    phi: vec(0, 1),
  },
  {
    id: 'd3',
    name: 'Peanut noodles',
    description: 'Sesame and peanut butter sauce',
    venueId: 'v2',
    venueName: 'Kopitiam',
    neighborhood: 'Chinatown',
    lat: REQUEST.lat,
    lng: REQUEST.lng,
    priceCents: 800,
    phi: vec(0, 0.5),
  },
  {
    id: 'd4',
    name: 'Shrimp toast',
    description: 'Fried shrimp paste on brioche',
    venueId: 'v2',
    venueName: 'Kopitiam',
    neighborhood: 'Chinatown',
    lat: REQUEST.lat,
    lng: REQUEST.lng,
    priceCents: 1000,
    phi: vec(0, 0.3),
  },
];

const MEMBERSHIPS: OrgMembership[] = [
  { userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' },
  { userId: 'u2', consentedAt: '2026-01-01T00:00:00Z' },
  { userId: 'u3', consentedAt: null }, // has a record, never consented
];

/** Answers with rows only for whoever it was asked about, and records every call. */
function trackingProvider(rowsByUser: Record<string, Array<{ kind: string; value: string }>>): {
  provider: HrisProvider;
  calls: HrisFetchRequest[];
} {
  const calls: HrisFetchRequest[] = [];
  const provider: HrisProvider = {
    id: 'fixture',
    isAvailable: () => true,
    async constraintsForOrg(request) {
      calls.push(request);
      const out: Array<{ userId: string; kind: string; value: string; consentedAt: string }> = [];
      for (const subject of request.subjects) {
        for (const c of rowsByUser[subject.userId] ?? []) {
          out.push({ userId: subject.userId, kind: c.kind, value: c.value, consentedAt: subject.consentedAt });
        }
      }
      return out;
    },
  };
  return { provider, calls };
}

const THETA = vec(0, 1);

describe('consent gate', () => {
  it('excludes an attendee with a membership record but no consent, and never asks a provider about them', async () => {
    // u3's row, if it were ever applied, would remove the peanut noodles too.
    // Proving they survive is proof u3 was never in scope.
    const { provider, calls } = trackingProvider({
      u1: [{ kind: 'religious', value: 'kosher' }],
      u2: [{ kind: 'dietary', value: 'vegetarian' }],
      u3: [{ kind: 'allergy', value: 'peanut allergy' }],
    });

    const result = await planTeamDinner(REQUEST, {
      dishes: inMemoryDishSource(MENU),
      members: inMemoryOrgMemberSource(MEMBERSHIPS),
      provider,
      taste: fixedGroupTaste(THETA),
    });

    const askedAbout = calls.flatMap((c) => c.subjects.map((s) => s.userId));
    expect(askedAbout).not.toContain('u3');

    const dishIds = result.candidates.flatMap((c) => c.dishIds);
    expect(dishIds).toContain('d3'); // peanut noodles survive: u3's allergy never applied
  });

  it('returns an honest empty result with nothing to count when nobody consented', async () => {
    const { provider } = trackingProvider({});
    const result = await planTeamDinner(REQUEST, {
      dishes: inMemoryDishSource(MENU),
      members: inMemoryOrgMemberSource([{ userId: 'u1', consentedAt: null }]),
      provider,
    });
    expect(result).toEqual({ candidates: [], constraintsAppliedCount: 0 });
  });
});

describe('the count without the values', () => {
  it('applies four constraints, exposes the count, and discloses no value or owner', async () => {
    const { provider } = trackingProvider({
      u1: [
        { kind: 'religious', value: 'kosher' },
        // Harmless against this menu on purpose: appliedCount must reach 4
        // even though this row matches nothing, per hard rule 3's own
        // "counted whether or not it matched" clause.
        { kind: 'allergy', value: 'no durian' },
      ],
      u2: [
        { kind: 'dietary', value: 'vegetarian' },
        { kind: 'allergy', value: 'no cilantro' },
      ],
    });

    const result = await planTeamDinner(REQUEST, {
      dishes: inMemoryDishSource(MENU),
      members: inMemoryOrgMemberSource(MEMBERSHIPS),
      provider,
      taste: fixedGroupTaste(THETA),
    });

    expect(result.constraintsAppliedCount).toBe(4);

    const serialized = JSON.stringify(result).toLowerCase();
    // "peanut" is deliberately not checked here: "Peanut noodles" is a menu
    // name that legitimately survives this filter and legitimately appears in
    // a rendered recommendation. Article 9 vocabulary is what must never
    // appear, not every word a constraint value happens to share with a dish.
    for (const forbidden of [
      'kosher', 'vegetarian', 'durian', 'cilantro', 'religious', 'dietary', 'allergy', 'u1', 'u2', 'u3',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    // The pork bun (kosher, vegetarian) and the shrimp toast (vegetarian) are
    // gone. Liang pi and the peanut noodles survive: nobody consented an
    // objection to either of them.
    const dishIds = result.candidates.flatMap((c) => c.dishIds);
    expect(dishIds).toContain('d1');
    expect(dishIds).toContain('d3');
    expect(dishIds).not.toContain('d2');
    expect(dishIds).not.toContain('d4');
  });

  it('exposes exactly candidates and constraintsAppliedCount, and only those two keys, frozen', async () => {
    const { provider } = trackingProvider({ u1: [{ kind: 'dietary', value: 'vegan' }] });
    const result = await planTeamDinner(REQUEST, {
      dishes: inMemoryDishSource(MENU),
      members: inMemoryOrgMemberSource(MEMBERSHIPS),
      provider,
      taste: fixedGroupTaste(THETA),
    });
    expect(Object.keys(result).sort()).toEqual(['candidates', 'constraintsAppliedCount']);
    expect(Object.isFrozen(result)).toBe(true);
    for (const c of result.candidates) {
      expect(Object.isFrozen(c)).toBe(true);
      expect(Object.keys(c).sort()).toEqual(['dishIds', 'reasonText', 'venueId']);
    }
  });
});

describe('no model call on the constraint path', () => {
  it('never calls the renderer when constraints remove every candidate', async () => {
    const generate = vi.fn(async () => 'should never run');
    const allAnimal: DinnerDish[] = [
      {
        id: 'x1', name: 'Pork belly bun', description: 'Braised pork belly',
        venueId: 'v1', venueName: 'Kopitiam', neighborhood: 'Chinatown',
        lat: REQUEST.lat, lng: REQUEST.lng, priceCents: 900, phi: vec(0, 1),
      },
      {
        id: 'x2', name: 'Shrimp toast', description: 'Fried shrimp paste on brioche',
        venueId: 'v1', venueName: 'Kopitiam', neighborhood: 'Chinatown',
        lat: REQUEST.lat, lng: REQUEST.lng, priceCents: 1000, phi: vec(0, 0.5),
      },
    ];
    const { provider } = trackingProvider({ u1: [{ kind: 'dietary', value: 'vegan' }] });

    const result = await planTeamDinner(REQUEST, {
      dishes: inMemoryDishSource(allAnimal),
      members: inMemoryOrgMemberSource([{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' }]),
      provider,
      taste: fixedGroupTaste(THETA),
      renderOptions: { dryRun: false, generate },
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.constraintsAppliedCount).toBe(1);
  });

  it('never lets a constraint value reach the render function on the surviving path either', async () => {
    const generate = vi.fn(async (req: GenerateRequest): Promise<string> => {
      const text = `${req.system}\n${req.messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n')}`;
      for (const forbidden of ['kosher', 'vegetarian', 'peanut allergy', 'religious', 'dietary']) {
        expect(text.toLowerCase()).not.toContain(forbidden);
      }
      // Only the count reaches the packet, and buildPacketBrief never speaks
      // it, so there is nothing about constraints for this text to echo.
      return 'no valid recommendation from this fixture';
    });

    const { provider } = trackingProvider({
      u1: [{ kind: 'religious', value: 'kosher' }],
      u2: [{ kind: 'dietary', value: 'vegetarian' }],
    });

    await planTeamDinner(REQUEST, {
      dishes: inMemoryDishSource(MENU),
      members: inMemoryOrgMemberSource(MEMBERSHIPS),
      provider,
      taste: fixedGroupTaste(THETA),
      renderOptions: { dryRun: false, generate, maxAttempts: 1 },
    });

    expect(generate).toHaveBeenCalled();
  });
});

describe('validateDinnerRequest', () => {
  it('reports every problem at once rather than the first', () => {
    const bad = { ...REQUEST, orgId: '', partySize: 0, lat: 999 } as EnterpriseDinnerRequest;
    const problems = validateDinnerRequest(bad);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts the fixture request as-is', () => {
    expect(validateDinnerRequest(REQUEST)).toEqual([]);
  });
});

describe('planTeamDinner request validation', () => {
  it('throws DinnerRequestError rather than touching a provider on a bad request', async () => {
    const spy = vi.fn(async () => {
      throw new Error('must not be called');
    });
    const provider: HrisProvider = { id: 'spy', isAvailable: () => true, constraintsForOrg: spy };

    await expect(
      planTeamDinner(
        { ...REQUEST, orgId: '' },
        { dishes: inMemoryDishSource(MENU), members: inMemoryOrgMemberSource(MEMBERSHIPS), provider },
      ),
    ).rejects.toBeInstanceOf(DinnerRequestError);

    expect(spy).not.toHaveBeenCalled();
  });
});
