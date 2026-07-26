/**
 * Constraint-filtered corpus access. Track C.
 *
 * Hard rule 3 says the filter runs before ANY model call, and every route that
 * shows a dish to a possibly-constrained person goes through this one
 * function rather than reimplementing the filter call at each site. Applying
 * it inconsistently across routes is how a constraint quietly stops covering
 * duels while still covering recommendations, which is a correctness bug with
 * the shape of a privacy incident.
 */

import type { Dish } from '@/contracts/types';
import { filterCandidatesForUsers, type ConstraintCandidate } from '@/lib/db';
import type { Identity } from './identity';

export interface ConstraintScopedDishes {
  dishes: Dish[];
  /** The only thing this ever reports about what got removed: a count. */
  appliedCount: number;
}

/**
 * Filter a dish pool to what this identity may be shown.
 *
 * Guarantees: a device-only identity (no userId) has no constraint rows to
 * apply, since constraints in contracts/schema.sql key off `users.id`, so the
 * result is the pool unchanged with appliedCount 0, the honest answer for
 * someone with no account to attach a constraint to. With a userId, rows are
 * fetched and applied as a set intersection, and nothing about a removed
 * dish, or why it was removed, is observable from the result.
 */
export async function constraintFilteredDishes(
  identity: Pick<Identity, 'userId'>,
  pool: readonly Dish[],
): Promise<ConstraintScopedDishes> {
  const candidates: ConstraintCandidate[] = pool.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    tags: [],
  }));
  const userIds = identity.userId ? [identity.userId] : [];
  const result = await filterCandidatesForUsers(userIds, candidates);
  const allowed = new Set(result.candidates.map((c) => c.id));
  return { dishes: pool.filter((d) => allowed.has(d.id)), appliedCount: result.appliedCount };
}
