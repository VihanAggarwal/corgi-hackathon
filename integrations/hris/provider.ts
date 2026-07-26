/**
 * Where employee constraint records come from. Track C.
 *
 * WHY AN INTERFACE INSTEAD OF A MERGE CLIENT
 * The original E1 plan assumed the Merge Unified API: one normalized HRIS
 * shape, one client, one call site. We do not have it. What we have is Agent
 * Handler (MCP, connector coverage thinner than the Unified API's) and a
 * self-declared table. Writing directly against Agent Handler would put a
 * vendor's wire format in the middle of the dinner route, and the vendor's
 * wire format is the one thing in this feature we have not verified.
 *
 * So the source is a seam. HrisProvider is the substitute for the Unified API:
 * it normalizes at OUR boundary rather than at Merge's. Agent Handler is one
 * implementation, the self-declared table is another, and Finch, Nango or
 * Apideck would be a third with no change above this line. If the Workday
 * connector turns out not to be enabled on our account at hour 60, the fix is
 * to not register one provider, not to rewrite a route.
 *
 * CONSENT IS CARRIED IN THE REQUEST, NOT LOOKED UP BY THE PROVIDER
 * A provider is handed HrisSubject records, and an HrisSubject cannot be
 * constructed without a non-null `consentedAt` taken from org_members. An
 * unconsented employee therefore has no shape a provider can be asked about,
 * which is a stronger guarantee than a provider remembering to check. See
 * lib/enterprise/members.ts, which is the only thing that builds them.
 *
 * VALUES TRAVEL IN, ONE INTEGER TRAVELS OUT
 * A provider returns ConstraintRow, which carries Article 9 values, because the
 * filter needs them. Nothing above this module is allowed to hold those rows,
 * so applyOrgConstraints is the public entry point: it fetches, filters and
 * discards inside one call and hands back ConstraintFilterResult, whose value,
 * kind and owner fields are typed `never` (hard rule 3). Callers that want the
 * rows have to reach past this function, which is a visible act rather than an
 * oversight.
 *
 * NOTHING HERE LOGS. Not the rows, not the count per user, not a caught error
 * body. A log line about this data is a retained record of who is kosher.
 */

import {
  applyConstraintRows,
  type ConstraintCandidate,
  type ConstraintFilterResult,
  type ConstraintRow,
} from '../../lib/db';
import { createSelfDeclaredProvider } from './self-declared';
import { createAgentHandlerProvider } from './agent-handler';

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/**
 * One person a provider may be asked about.
 *
 * `consentedAt` is required and non-null on purpose. It is org_members
 * .consented_at, our own consent record, never a flag the vendor returned:
 * an HRIS knowing someone is celiac is not that person agreeing that a dinner
 * planner may use it.
 */
export interface HrisSubject {
  /** users.id in our schema. */
  readonly userId: string;
  /** org_members.consented_at, ISO 8601. Never null: see the type. */
  readonly consentedAt: string;
  /** org_members.merge_employee_id. The id the HRIS knows this person by. */
  readonly employeeId?: string | null;
}

export interface HrisFetchRequest {
  readonly orgId: string;
  /** Consented members only. A provider must not widen this set. */
  readonly subjects: readonly HrisSubject[];
  /**
   * orgs.merge_account_token, the per-org linked-account credential. Opaque,
   * server-only, and never logged or echoed.
   */
  readonly accountToken?: string | null;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface HrisProvider {
  /** Stable identifier, used for provider selection in tests and for nothing else. */
  readonly id: string;

  /**
   * Whether this provider can run right now.
   *
   * Evaluated per call, never at import, so a provider whose credential appears
   * later in the process lifetime starts working without a restart, and a
   * missing credential can never throw during module evaluation.
   */
  isAvailable(): boolean;

  /**
   * Constraint records for these subjects.
   *
   * May over-return and may return rows for people who were not asked about:
   * the registry re-scopes and re-gates before anything is applied, so a
   * sloppy or hostile provider cannot widen the constraint set.
   */
  constraintsForOrg(request: HrisFetchRequest): Promise<readonly ConstraintRow[]>;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * A vendor response is not trusted to be bounded. Ten thousand rows for a party
 * of six is a bug or an attack, and either way we are not going to apply them.
 */
const MAX_ROWS = 1000;

/**
 * Re-scope and re-gate whatever a provider returned.
 *
 * Guarantees: every returned row belongs to a subject in the request, carries a
 * non-empty consent timestamp, and has a non-empty trimmed value. Rows are
 * capped at MAX_ROWS. This runs on every provider including our own, because
 * "our own implementation is careful" stops being true the moment somebody adds
 * a fourth one.
 */
export function normalizeHrisRows(
  request: HrisFetchRequest,
  rows: readonly ConstraintRow[],
): readonly ConstraintRow[] {
  const consentBySubject = new Map<string, string>();
  for (const s of request.subjects) {
    if (typeof s.consentedAt === 'string' && s.consentedAt.trim().length > 0) {
      consentBySubject.set(s.userId, s.consentedAt);
    }
  }

  const out: ConstraintRow[] = [];
  for (const row of rows) {
    if (out.length >= MAX_ROWS) break;
    const consent = consentBySubject.get(row.userId);
    if (consent === undefined) continue;

    const value = typeof row.value === 'string' ? row.value.trim() : '';
    if (value.length === 0) continue;

    out.push({
      userId: row.userId,
      kind: typeof row.kind === 'string' ? row.kind : '',
      value,
      // The subject's consent record wins over whatever the row arrived with.
      // A provider cannot grant consent it was not given.
      consentedAt: consent,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry: HrisProvider[] = [];
let defaultsInstalled = false;

/**
 * Install the built-in providers in priority order.
 *
 * Agent Handler first because it is the real HRIS when it is configured, and
 * self-declared last because its isAvailable() is unconditionally true, which
 * makes it the floor rather than an option. Resolution can therefore never
 * fail, which is what lets the demo run with no credentials at all.
 */
function installDefaults(): void {
  if (defaultsInstalled) return;
  defaultsInstalled = true;
  registry.push(createAgentHandlerProvider());
  registry.push(createSelfDeclaredProvider());
}

/**
 * Add a provider ahead of the built-ins.
 *
 * Guarantees: the newly registered provider is consulted before Agent Handler
 * and before self-declared. This is the seam a future vendor lands in.
 */
export function registerHrisProvider(provider: HrisProvider): void {
  installDefaults();
  registry.unshift(provider);
}

/** Restore the built-in registry. Test hook, and the only way to undo a register. */
export function resetHrisProviders(): void {
  registry.length = 0;
  defaultsInstalled = false;
}

/**
 * The first provider that can run.
 *
 * Guarantees: never throws and never returns null. With no Merge credential
 * present this is the self-declared provider, which is also the honest answer
 * for a company that has no HRIS connector.
 */
export function resolveHrisProvider(): HrisProvider {
  installDefaults();
  for (const provider of registry) {
    if (provider.isAvailable()) return provider;
  }
  // Unreachable while self-declared is registered. Kept because a resolution
  // that returned undefined would surface as a null-deref inside a route
  // handler rather than as a missing provider.
  return createSelfDeclaredProvider();
}

/** Provider ids in priority order. Diagnostics only, carries no employee data. */
export function hrisProviderIds(): string[] {
  installDefaults();
  return registry.map((p) => p.id);
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * Fetch this org's constraints and apply them to a candidate list.
 *
 * Guarantees:
 *  - The set intersection happens here, before the caller can do anything else
 *    with the candidates, and in particular before any model call. There is no
 *    ordering for a caller to get wrong because there is no unfiltered list to
 *    hand to a renderer.
 *  - Constraint rows are fetched, normalized, applied and dropped inside this
 *    call. No caller ever holds one.
 *  - The return value is ConstraintFilterResult: surviving candidates plus one
 *    non-negative integer. Values, kinds, owners and removal reasons are typed
 *    `never` and checked at runtime by the filter itself.
 *  - With no subjects, no provider call is made at all.
 *  - A provider failure throws. It does NOT fall back to a thinner source:
 *    quietly applying fewer constraints than the org has is how somebody gets
 *    served the thing they are allergic to, so a broken connector has to be a
 *    failed request.
 */
export async function applyOrgConstraints<T extends ConstraintCandidate>(
  request: HrisFetchRequest,
  candidates: readonly T[],
  provider: HrisProvider = resolveHrisProvider(),
): Promise<ConstraintFilterResult<T>> {
  const userIds = request.subjects.map((s) => s.userId);
  if (userIds.length === 0) {
    return applyConstraintRows<T>([], candidates, []);
  }

  const raw = await provider.constraintsForOrg(request);
  const rows = normalizeHrisRows(request, raw);
  return applyConstraintRows<T>(userIds, candidates, rows);
}
