/**
 * Per-org Merge linked-account token. Track C.
 *
 * orgs.merge_account_token tells Agent Handler which linked HRIS account to
 * query for a given org (see docs/TRACK-C-MERGE-BRIEF.md). It is looked up
 * here, one function, rather than inline in the route handler, so the "no
 * credentials, no crash" convention every other Track C data source follows
 * applies to this one too.
 *
 * NOTHING HERE LOGS. A token is a live credential for someone else's linked
 * HRIS account, and an error message built from a failed lookup is exactly the
 * kind of string that ends up pasted into a bug report.
 */

import { getServiceClient, hasServiceRoleCredentials } from '../db';

interface OrgTokenRow {
  merge_account_token?: unknown;
}

/**
 * The linked-account token for an org, or null.
 *
 * Guarantees: returns null, never throws, when there is no service-role
 * credential, the org row does not exist, the column is null, or the query
 * itself fails. A missing token degrades to an unscoped Agent Handler call, or,
 * with no Merge key at all, straight to the self-declared provider, which is
 * the same "keep the dinner working" choice every other optional field in this
 * feature makes.
 */
export async function defaultOrgAccountToken(orgId: string): Promise<string | null> {
  if (!hasServiceRoleCredentials()) return null;
  try {
    const client = getServiceClient();
    const { data, error } = await client
      .from('orgs')
      .select('merge_account_token')
      .eq('id', orgId)
      .maybeSingle();
    if (error || !data) return null;
    const token = (data as OrgTokenRow).merge_account_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
