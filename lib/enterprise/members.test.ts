/**
 * Consent gate tests. Track C.
 *
 * consentedSubjects is the one function that turns a membership row into
 * something a provider may be asked about. Every test here corresponds to a
 * way an unconsented or uninvited person could otherwise end up in that set.
 */

import { describe, expect, it } from 'vitest';
import { consentedSubjects, inMemoryOrgMemberSource, type OrgMembership } from './members';

describe('consentedSubjects', () => {
  it('excludes a requested user who has a record but a null consentedAt', () => {
    const memberships: OrgMembership[] = [{ userId: 'u1', consentedAt: null }];
    const out = consentedSubjects(memberships, ['u1']);
    expect(out).toEqual([]);
  });

  it('excludes a requested user with no membership row at all, even though they exist elsewhere', () => {
    const memberships: OrgMembership[] = [{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' }];
    const out = consentedSubjects(memberships, ['u1', 'u2']);
    expect(out.map((s) => s.userId)).toEqual(['u1']);
  });

  it('excludes a membership whose consentedAt is an empty or whitespace string', () => {
    const memberships: OrgMembership[] = [
      { userId: 'u1', consentedAt: '' },
      { userId: 'u2', consentedAt: '   ' },
    ];
    const out = consentedSubjects(memberships, ['u1', 'u2']);
    expect(out).toEqual([]);
  });

  it('includes a consented user and carries their employeeId through', () => {
    const memberships: OrgMembership[] = [
      { userId: 'u1', consentedAt: '2026-01-01T00:00:00Z', mergeEmployeeId: 'emp-1' },
    ];
    const out = consentedSubjects(memberships, ['u1']);
    expect(out).toEqual([{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z', employeeId: 'emp-1' }]);
  });

  it('never adds an attendee nobody requested, even if a source over-returns', () => {
    const memberships: OrgMembership[] = [
      { userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' },
      { userId: 'u2', consentedAt: '2026-01-01T00:00:00Z' },
    ];
    const out = consentedSubjects(memberships, ['u1']);
    expect(out.map((s) => s.userId)).toEqual(['u1']);
  });

  it('collapses a duplicated request to one subject', () => {
    const memberships: OrgMembership[] = [{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' }];
    const out = consentedSubjects(memberships, ['u1', 'u1']);
    expect(out).toHaveLength(1);
  });

  it('preserves the requested order, not the membership order', () => {
    const memberships: OrgMembership[] = [
      { userId: 'u2', consentedAt: '2026-01-01T00:00:00Z' },
      { userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' },
    ];
    const out = consentedSubjects(memberships, ['u1', 'u2']);
    expect(out.map((s) => s.userId)).toEqual(['u1', 'u2']);
  });
});

describe('inMemoryOrgMemberSource', () => {
  it('scopes to the requested users only', async () => {
    const source = inMemoryOrgMemberSource([
      { userId: 'u1', consentedAt: '2026-01-01T00:00:00Z' },
      { userId: 'u2', consentedAt: null },
    ]);
    const rows = await source.membershipsForOrg('org1', ['u1']);
    expect(rows.map((r) => r.userId)).toEqual(['u1']);
  });
});
