/**
 * Twin computation glue between the in-memory store and Track A's model.
 * Track C.
 *
 * NO LIVE RELIABILITY MODEL
 * computeTwins weights every candidate by a reliability score, and
 * contracts/schema.sql's `reliability` table exists for exactly that, but
 * nothing in this build populates it: reliability is an out-of-sample hit
 * rate that only exists after a real feedback loop has run, and there is no
 * live database here to run one against. Every identity gets the schema's own
 * default, 0.5, a neutral "no information yet" prior rather than a guess in
 * either direction. This is a genuine gap against the frozen contract, not a
 * hidden shortcut: it is named here, and reliability never leaves this file
 * regardless, per core/twins.ts's own guarantee (hard rule 1).
 */

import { CONSTANTS } from '@/contracts/types';
import { computeTwins, type TwinCandidate, type TwinComputation, type TwinSelf } from '@/core';
import { listOtherIdentities, type StoredIdentity } from '@/lib/store/memory';

/** Matches the `reliability.score` column default in contracts/schema.sql. */
const DEFAULT_RELIABILITY = 0.5;

/**
 * Compute the twin set for a stored identity against every other identity the
 * in-memory store currently knows about.
 *
 * Guarantees: identical in shape to what a Supabase-backed candidate pool
 * would produce, so callers (profile, recommend) do not need to know the
 * store is in-memory. Below MIN_DUELS_FOR_TWINS duels, or below K_FLOOR
 * independent supporters, computeTwins itself returns status.enabled: false
 * and an empty links array, hard rule 5 enforced by Track A, not repeated here.
 */
export function computeTwinsForIdentity(identity: StoredIdentity): TwinComputation {
  const self: TwinSelf = {
    userId: identity.key,
    theta: identity.theta,
    nComparisons: identity.nComparisons,
  };

  const candidates: TwinCandidate[] = listOtherIdentities(identity.key)
    .filter((i) => i.nComparisons >= CONSTANTS.MIN_DUELS_FOR_TWINS)
    .map((i) => ({
      userId: i.key,
      theta: i.theta,
      nComparisons: i.nComparisons,
      reliability: DEFAULT_RELIABILITY,
      provenance: { inviterId: null, fingerprint: i.fingerprint, createdAt: i.createdAt },
    }));

  return computeTwins({
    self,
    candidates,
    selfProvenance: { inviterId: null, fingerprint: identity.fingerprint, createdAt: identity.createdAt },
  });
}
