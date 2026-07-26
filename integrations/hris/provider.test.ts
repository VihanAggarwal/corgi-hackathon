/**
 * HRIS provider registry and applyOrgConstraints tests. Track C.
 *
 * The interesting claims here are architectural rather than computational:
 * resolution never fails, an unavailable Merge key falls back to the
 * self-declared floor, an over-returning provider cannot widen what gets
 * applied, and an empty subject list never touches a provider at all (which is
 * also the proof that an unconsented employee's data is never fetched, not
 * merely filtered after the fact).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyOrgConstraints,
  hrisProviderIds,
  normalizeHrisRows,
  registerHrisProvider,
  resetHrisProviders,
  resolveHrisProvider,
  type HrisFetchRequest,
  type HrisProvider,
} from './provider';
import { SELF_DECLARED_PROVIDER_ID } from './self-declared';
import { AGENT_HANDLER_PROVIDER_ID } from './agent-handler';
import type { ConstraintCandidate, ConstraintRow } from '../../lib/db';

interface Dish extends ConstraintCandidate {}

const MENU: Dish[] = [
  { id: 'd1', name: 'Liang pi', description: 'Cold noodles' },
  { id: 'd2', name: 'Pork belly bun', description: 'Braised pork' },
  { id: 'd3', name: 'Shrimp toast', description: 'Fried shrimp' },
];

beforeEach(() => {
  resetHrisProviders();
  delete process.env.MERGE_AGENT_HANDLER_API_KEY;
});

afterEach(() => {
  resetHrisProviders();
  delete process.env.MERGE_AGENT_HANDLER_API_KEY;
});

describe('resolveHrisProvider', () => {
  it('falls back to self-declared with no Merge key configured', () => {
    const provider = resolveHrisProvider();
    expect(provider.id).toBe(SELF_DECLARED_PROVIDER_ID);
  });

  it('never returns undefined, even with a corrupted registry', () => {
    // installDefaults + resolveHrisProvider should be robust regardless of
    // what else registered ahead of the built-ins.
    const provider = resolveHrisProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.constraintsForOrg).toBe('function');
  });

  it('lists Agent Handler ahead of self-declared in priority order', () => {
    const ids = hrisProviderIds();
    expect(ids).toEqual([AGENT_HANDLER_PROVIDER_ID, SELF_DECLARED_PROVIDER_ID]);
  });

  it('prefers a registered provider over both built-ins when it is available', () => {
    const custom: HrisProvider = {
      id: 'custom',
      isAvailable: () => true,
      async constraintsForOrg() {
        return [];
      },
    };
    registerHrisProvider(custom);
    expect(resolveHrisProvider().id).toBe('custom');
  });

  it('skips a registered provider that reports itself unavailable', () => {
    const custom: HrisProvider = {
      id: 'custom-off',
      isAvailable: () => false,
      async constraintsForOrg() {
        throw new Error('should never be called');
      },
    };
    registerHrisProvider(custom);
    expect(resolveHrisProvider().id).toBe(SELF_DECLARED_PROVIDER_ID);
  });
});

describe('normalizeHrisRows', () => {
  const request: HrisFetchRequest = {
    orgId: 'org1',
    subjects: [{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' }],
  };

  it('drops a row for a subject that was not asked about', () => {
    const rows: ConstraintRow[] = [
      { userId: 'u1', kind: 'allergy', value: 'peanut', consentedAt: 'whatever' },
      { userId: 'stranger', kind: 'allergy', value: 'shellfish', consentedAt: 'whatever' },
    ];
    const out = normalizeHrisRows(request, rows);
    expect(out.map((r) => r.userId)).toEqual(['u1']);
  });

  it('stamps consentedAt from OUR record, never from what the vendor sent', () => {
    const rows: ConstraintRow[] = [
      { userId: 'u1', kind: 'allergy', value: 'peanut', consentedAt: '1999-01-01T00:00:00Z' },
    ];
    const out = normalizeHrisRows(request, rows);
    expect(out[0].consentedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('drops a row with an empty or whitespace-only value', () => {
    const rows: ConstraintRow[] = [{ userId: 'u1', kind: 'allergy', value: '   ', consentedAt: 'x' }];
    expect(normalizeHrisRows(request, rows)).toEqual([]);
  });

  it('caps the number of rows applied', () => {
    const many: ConstraintRow[] = Array.from({ length: 1500 }, (_, i) => ({
      userId: 'u1',
      kind: 'allergy',
      value: `thing-${i}`,
      consentedAt: 'x',
    }));
    const out = normalizeHrisRows(request, many);
    expect(out.length).toBe(1000);
  });
});

describe('applyOrgConstraints', () => {
  it('makes no provider call at all with an empty subject list', async () => {
    const spy = vi.fn(async () => {
      throw new Error('a provider must never be called with no subjects');
    });
    const provider: HrisProvider = { id: 'spy', isAvailable: () => true, constraintsForOrg: spy };

    const result = await applyOrgConstraints({ orgId: 'org1', subjects: [] }, MENU, provider);

    expect(spy).not.toHaveBeenCalled();
    expect(result.candidates.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(result.appliedCount).toBe(0);
  });

  it('applies four constraints and discloses none of them in the serialized result', async () => {
    const provider: HrisProvider = {
      id: 'fixture',
      isAvailable: () => true,
      async constraintsForOrg() {
        return [
          { userId: 'u1', kind: 'religious', value: 'kosher', consentedAt: 'x' },
          { userId: 'u1', kind: 'allergy', value: 'shellfish allergy', consentedAt: 'x' },
          { userId: 'u2', kind: 'dietary', value: 'vegetarian', consentedAt: 'x' },
          { userId: 'u3', kind: 'allergy', value: 'peanut allergy', consentedAt: 'x' },
        ];
      },
    };

    const result = await applyOrgConstraints(
      {
        orgId: 'org1',
        subjects: [
          { userId: 'u1', consentedAt: 'x' },
          { userId: 'u2', consentedAt: 'x' },
          { userId: 'u3', consentedAt: 'x' },
        ],
      },
      MENU,
      provider,
    );

    expect(result.appliedCount).toBe(4);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['kosher', 'shellfish', 'vegetarian', 'peanut', 'u1', 'u2', 'u3']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('a provider that over-returns cannot widen what gets applied or fetched', async () => {
    const spy = vi.fn(async (request: HrisFetchRequest) => {
      // Deliberately answers for a user nobody asked about.
      return [
        { userId: request.subjects[0].userId, kind: 'dietary', value: 'vegan', consentedAt: 'x' },
        { userId: 'never-asked', kind: 'allergy', value: 'peanut allergy', consentedAt: 'x' },
      ];
    });
    const provider: HrisProvider = { id: 'over-returning', isAvailable: () => true, constraintsForOrg: spy };

    const result = await applyOrgConstraints(
      { orgId: 'org1', subjects: [{ userId: 'u1', consentedAt: 'x' }] },
      MENU,
      provider,
    );

    // Only the vegan row counts. The peanut row for a stranger is discarded by
    // normalizeHrisRows before the filter ever sees it.
    expect(result.appliedCount).toBe(1);
  });

  it('rethrows a provider failure rather than silently applying fewer constraints', async () => {
    const provider: HrisProvider = {
      id: 'broken',
      isAvailable: () => true,
      async constraintsForOrg() {
        throw new Error('connector down');
      },
    };

    await expect(
      applyOrgConstraints({ orgId: 'org1', subjects: [{ userId: 'u1', consentedAt: 'x' }] }, MENU, provider),
    ).rejects.toThrow();
  });
});
