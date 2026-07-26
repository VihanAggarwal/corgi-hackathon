/**
 * Self-declared HRIS provider tests. Track C.
 *
 * This is the floor provider: it must never fail to construct, and with fixed
 * rows it must never touch a database. Both are asserted here because both are
 * what makes the demo runnable with no credentials.
 */

import { describe, expect, it } from 'vitest';
import { createSelfDeclaredProvider, SELF_DECLARED_PROVIDER_ID } from './self-declared';
import type { HrisFetchRequest } from './provider';

function req(overrides: Partial<HrisFetchRequest> = {}): HrisFetchRequest {
  return { orgId: 'org1', subjects: [], accountToken: null, ...overrides };
}

describe('createSelfDeclaredProvider', () => {
  it('is always available', () => {
    const provider = createSelfDeclaredProvider();
    expect(provider.isAvailable()).toBe(true);
    expect(provider.id).toBe(SELF_DECLARED_PROVIDER_ID);
  });

  it('returns no rows and touches nothing with an empty subject list', async () => {
    const provider = createSelfDeclaredProvider({
      rows: [{ userId: 'u1', kind: 'religious', value: 'kosher', consentedAt: '2026-01-01T00:00:00Z' }],
    });
    const rows = await provider.constraintsForOrg(req());
    expect(rows).toEqual([]);
  });

  it('returns only rows for the requested subjects, from a fixed set with no database', async () => {
    const provider = createSelfDeclaredProvider({
      rows: [
        { userId: 'u1', kind: 'allergy', value: 'peanut allergy', consentedAt: '2026-01-01T00:00:00Z' },
        { userId: 'u2', kind: 'religious', value: 'kosher', consentedAt: '2026-01-01T00:00:00Z' },
      ],
    });

    const rows = await provider.constraintsForOrg(
      req({ subjects: [{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' }] }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('u1');
  });

  it('drops a fixed row whose own consentedAt is null even if requested', async () => {
    const provider = createSelfDeclaredProvider({
      rows: [{ userId: 'u1', kind: 'allergy', value: 'peanut allergy', consentedAt: null }],
    });
    const rows = await provider.constraintsForOrg(
      req({ subjects: [{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' }] }),
    );
    expect(rows).toEqual([]);
  });

  it('returns no rows with no fixed rows and no service-role credential, rather than throwing', async () => {
    // No SUPABASE_SERVICE_ROLE_KEY exists in this environment. The provider
    // must degrade, not crash the dinner request.
    const provider = createSelfDeclaredProvider();
    const rows = await provider.constraintsForOrg(
      req({ subjects: [{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' }] }),
    );
    expect(rows).toEqual([]);
  });
});
