/**
 * Database layer public surface. Track C.
 *
 * Route handlers and integrations import from '@/lib/db' and nowhere else.
 * Deep imports into this directory are how the seam stops being a seam, and in
 * this particular directory they are also how someone ends up holding a raw
 * constraint row.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * There is no export that returns a constraint value, a constraint kind, or
 * whose constraint it was. ConstraintRow is exported as a TYPE only, because
 * the enterprise path has to build rows from the Merge MCP client before
 * handing them to applyConstraintRows. Values travel inward. The only thing
 * that travels back out is ConstraintFilterResult, whose forbidden fields are
 * typed `never` (hard rule 3).
 *
 * BROWSER SAFETY
 * getAnonClient is safe anywhere. getServiceClient throws in a browser context
 * rather than constructing, so importing this module from a client component
 * cannot produce an RLS-bypassing client. See client.ts for why the key's
 * variable name, not its handling, is what makes that true.
 */

export {
  getAnonClient,
  getServiceClient,
  hasAnonCredentials,
  hasServiceRoleCredentials,
  resetSupabaseClients,
  assertServiceRoleNotPublic,
  MissingSupabaseConfigError,
  ServiceRoleInBrowserError,
  ServiceRoleExposedError,
} from './client';

export {
  applyConstraintRows,
  filterCandidatesForUsers,
  inMemoryConstraintSource,
  supabaseConstraintSource,
  defaultConstraintSource,
  type ConstraintCandidate,
  type ConstraintFilterResult,
  type ConstraintRow,
  type ConstraintSource,
} from './constraints';
