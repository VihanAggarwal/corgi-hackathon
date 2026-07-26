/**
 * The consent gate for the enterprise path. Track C.
 *
 * An attendee is usable only when `org_members.consented_at` is set for that
 * org. No exceptions, including for the demo. This is the guarantee the whole
 * feature rests on: Merge's audit trail will record every HRIS tool call, so
 * "we had consent on file" has to be true of every row that call touched.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE FILTER
 * There are two consent timestamps in play and they answer different questions.
 * `constraints.consented_at` is "this person agreed we may hold this record".
 * `org_members.consented_at` is "this person agreed their employer's dinner
 * planner may act on it". An employee can have the first without the second,
 * and treating them as one field is the bug that quietly opts a whole company
 * in. This file owns the second. lib/db owns the first.
 *
 * WHY IT PRODUCES HrisSubject RATHER THAN A LIST OF IDS
 * HrisSubject requires a non-null consentedAt, so an unconsented member has no
 * shape any provider can be asked about. The gate is therefore enforced by what
 * can be constructed rather than by a check somebody has to remember. Passing
 * bare ids would leave the provider to look consent up, and a provider is
 * exactly the component we are least willing to trust with it.
 */

import { getServiceClient, hasServiceRoleCredentials } from '../db';
import type { HrisSubject } from '../../integrations/hris/provider';

/** One row of org_members, as this module needs to see it. */
export interface OrgMembership {
  userId: string;
  /** Null means no consent, which means the person is not an attendee. */
  consentedAt: string | null;
  /** org_members.merge_employee_id. Null for a member with no HRIS record. */
  mergeEmployeeId?: string | null;
}

/** Where memberships come from. One method, so a fake is three lines. */
export interface OrgMemberSource {
  membershipsForOrg(
    orgId: string,
    userIds: readonly string[],
  ): Promise<readonly OrgMembership[]>;
}

/**
 * Turn memberships into the subjects a provider may be asked about.
 *
 * Guarantees:
 *  - A user with no membership row for this org is excluded. Not being a member
 *    is not the same as being a member who declined, and neither is an attendee.
 *  - A membership with a null, empty, or non-string consentedAt is excluded.
 *  - Only users in `requested` appear, in the order they were requested, with
 *    duplicates collapsed. A membership source that over-returns cannot add an
 *    attendee nobody invited.
 *  - The returned consentedAt is the membership's own timestamp, so it is the
 *    value that later gets stamped onto every constraint row for that person.
 */
export function consentedSubjects(
  memberships: readonly OrgMembership[],
  requested: readonly string[],
): HrisSubject[] {
  const byUser = new Map<string, OrgMembership>();
  for (const m of memberships) {
    if (!byUser.has(m.userId)) byUser.set(m.userId, m);
  }

  const seen = new Set<string>();
  const out: HrisSubject[] = [];
  for (const userId of requested) {
    if (seen.has(userId)) continue;
    seen.add(userId);

    const membership = byUser.get(userId);
    if (!membership) continue;

    const consentedAt = membership.consentedAt;
    if (typeof consentedAt !== 'string' || consentedAt.trim().length === 0) continue;

    out.push({
      userId,
      consentedAt,
      employeeId: membership.mergeEmployeeId ?? null,
    });
  }
  return out;
}

/**
 * A source backed by a fixed list.
 *
 * Guarantees: no network, no database, no credentials. This is what the tests
 * and the seeded demo run against.
 */
export function inMemoryOrgMemberSource(rows: readonly OrgMembership[]): OrgMemberSource {
  const snapshot = rows.map((r) => ({ ...r }));
  return {
    async membershipsForOrg(orgId, userIds) {
      const wanted = new Set(userIds);
      return snapshot.filter((r) => wanted.has(r.userId));
    },
  };
}

/**
 * A source backed by `org_members`, read with the service role.
 *
 * Guarantees: scoped to one org and to the requested users, selects only the
 * three columns this module uses, and applies the consent predicate in SQL as
 * well as in consentedSubjects. A query error throws with no row detail
 * attached: an error body is a log line waiting to happen.
 */
export function supabaseOrgMemberSource(): OrgMemberSource {
  return {
    async membershipsForOrg(orgId, userIds) {
      if (userIds.length === 0) return [];
      const client = getServiceClient();
      const { data, error } = await client
        .from('org_members')
        .select('user_id, merge_employee_id, consented_at')
        .eq('org_id', orgId)
        .in('user_id', [...userIds])
        .not('consented_at', 'is', null);

      if (error) throw new Error('Org membership lookup failed.');

      return (data ?? []).map((row: Record<string, unknown>) => ({
        userId: String(row.user_id ?? ''),
        consentedAt: row.consented_at == null ? null : String(row.consented_at),
        mergeEmployeeId: row.merge_employee_id == null ? null : String(row.merge_employee_id),
      }));
    },
  };
}

/**
 * The source to use when the caller has no opinion.
 *
 * Live when a service-role credential exists, empty otherwise. Empty is the
 * safe direction here, unlike the constraint filter: with no memberships there
 * are no consented attendees, so the dinner returns no candidates rather than
 * planning one for people who never agreed to be planned for.
 */
export function defaultOrgMemberSource(): OrgMemberSource {
  if (hasServiceRoleCredentials()) return supabaseOrgMemberSource();
  return inMemoryOrgMemberSource([]);
}
