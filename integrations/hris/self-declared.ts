/**
 * The self-declared constraint provider. Track C.
 *
 * Reads `constraints` where source = 'self': the rows a person entered about
 * themselves. Zero dependencies beyond the database we already have, no vendor,
 * no network to a third party, no credential that has to exist.
 *
 * WHY THIS IS THE FLOOR AND NOT THE FALLBACK
 * Two different situations land here and both are normal. The first is the
 * demo, where no Merge credential exists and the whole feature still has to
 * work end to end. The second is a real company with no HRIS connector, which
 * is most of them; "we cannot do dietary constraints unless you run Workday"
 * is not an answer. contracts/schema.sql already types
 * `source text default 'self'`, so the filter path is identical either way and
 * only the provenance differs. The organizer sees "4 constraints applied" and
 * never which or whose, exactly as with Agent Handler.
 *
 * WHY source = 'self' RATHER THAN EVERY ROW
 * A provider that returned rows from every source would double-count when Agent
 * Handler is also live, and appliedCount is the one number this feature
 * publishes. Each provider owns its own provenance.
 *
 * NO CREDENTIALS, NO CRASH
 * With no SUPABASE_SERVICE_ROLE_KEY this returns no rows rather than throwing.
 * That is fail-open on filtering and it is stated rather than hidden: with no
 * database there are also no users and no constraint rows to honour, so the
 * alternative is a feature that cannot be demonstrated. The moment the key
 * appears this switches to the live table with no code change. The same
 * reasoning and the same behaviour as defaultConstraintSource in lib/db.
 */

import { getServiceClient, hasServiceRoleCredentials, type ConstraintRow } from '../../lib/db';
import type { HrisFetchRequest, HrisProvider } from './provider';

export const SELF_DECLARED_PROVIDER_ID = 'self-declared';

export interface SelfDeclaredOptions {
  /**
   * Fixed rows instead of a database read. Used by tests and by the seeded
   * demo. Present so that proving this provider correct does not require
   * Supabase to be reachable.
   */
  rows?: readonly ConstraintRow[];
}

/**
 * Build the self-declared provider.
 *
 * Guarantees:
 *  - isAvailable() is unconditionally true, which is what makes it the last
 *    resort in the registry and the reason resolution can never fail.
 *  - Returns only rows for the subjects in the request, only with source
 *    'self', and only with a non-null consented_at. The consent predicate is
 *    applied in SQL here and again in the filter, because a SQL predicate is
 *    one edit away from being widened by someone debugging an empty result.
 *  - Never logs a row, a value, or a database error body.
 */
export function createSelfDeclaredProvider(options: SelfDeclaredOptions = {}): HrisProvider {
  const fixed = options.rows ? options.rows.map((r) => ({ ...r })) : null;

  return {
    id: SELF_DECLARED_PROVIDER_ID,

    isAvailable(): boolean {
      return true;
    },

    async constraintsForOrg(request: HrisFetchRequest): Promise<readonly ConstraintRow[]> {
      const wanted = new Set(request.subjects.map((s) => s.userId));
      if (wanted.size === 0) return [];

      if (fixed) {
        return fixed.filter((r) => wanted.has(r.userId) && r.consentedAt != null);
      }

      if (!hasServiceRoleCredentials()) return [];

      const client = getServiceClient();
      const { data, error } = await client
        .from('constraints')
        .select('user_id, kind, value, consented_at')
        .in('user_id', [...wanted])
        .eq('source', 'self')
        .not('consented_at', 'is', null);

      if (error) {
        // Deliberately generic and deliberately not logged. Supabase puts the
        // failing predicate, and therefore sometimes the values, in the error.
        throw new Error('Self-declared constraint lookup failed.');
      }

      return (data ?? []).map((row: Record<string, unknown>) => ({
        userId: String(row.user_id ?? ''),
        kind: String(row.kind ?? ''),
        value: String(row.value ?? ''),
        consentedAt: row.consented_at == null ? null : String(row.consented_at),
      }));
    },
  };
}
