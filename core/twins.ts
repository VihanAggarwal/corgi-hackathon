/**
 * Taste twins. Track A.
 *
 * A twin is a stranger whose fitted theta predicts yours. Similarity is cosine
 * over theta and nothing else.
 *
 * NO SOCIAL GRAPH INPUT. There is no friendship parameter in this file and
 * there must never be one. Being invited by someone, sharing a thread with
 * them, or knowing them carries exactly zero weight in who your twins are.
 * Friends are how people arrive, not where recommendations come from. The only
 * place account provenance appears below is as a DISQUALIFIER: a supporter who
 * is entangled with another supporter cannot count twice. Provenance can only
 * ever remove a twin, never add one and never raise a weight.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT
 * The cheap attack on any word-of-mouth system is to manufacture the mouths.
 * Five accounts made in one back office, on one laptop, in one afternoon, all
 * tuned to one taste cluster, would otherwise clear the k-floor and put a dish
 * in front of every real member of that cluster. So the k=5 supporting set is
 * checked for pairwise independence on three axes of entanglement: invite
 * chain, device fingerprint, and account-creation burst. Failing any one of
 * them collapses the group to a single supporter.
 *
 * Hard rule 1: reliability, cosine and weight are numbers about people. They
 * are internal. `toClientTwinView` is the only shape that crosses to a caller,
 * and it is typed so that carrying them is a compile error rather than a code
 * review question.
 *
 * Hard rule 5: below k=5 independent supporters the channel is off and the UI
 * says nothing about twins at all.
 */

import { AXES, AXIS_COUNT } from '../contracts/axes';
import {
  CONSTANTS,
  type EvidencePacket,
  type TwinLink,
  type TwinStatus,
  type Vec24,
} from '../contracts/types';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The three facts about an account that can prove entanglement with another
 * account. This is anti-fraud metadata, not profile data: it is never scored,
 * never rendered, and never leaves this module.
 */
export interface AccountProvenance {
  /** Who invited this account, if anyone. Used ONLY to disqualify, never to score. */
  inviterId: string | null;
  /** Device fingerprint. Null means unknown, which is not the same as independent. */
  fingerprint: string | null;
  /** ISO timestamp of account creation. */
  createdAt: string;
}

export interface TwinCandidate {
  userId: string;
  theta: Vec24;
  nComparisons: number;
  /**
   * Out-of-sample hit rate, 0..1. INTERNAL ONLY, never renderable.
   * A user who is similar but noisy must contribute nothing, which is why this
   * multiplies the cosine rather than sitting beside it.
   */
  reliability: number;
  provenance: AccountProvenance;
}

export interface TwinSelf {
  userId: string;
  theta: Vec24;
  nComparisons: number;
}

export interface TwinComputationInput {
  self: TwinSelf;
  candidates: TwinCandidate[];
  /**
   * Provenance of the requesting user, when known. An account on the same
   * device as the requester, or on the same invite chain root, is that person's
   * own second account or their recruiter, not an independent supporter.
   */
  selfProvenance?: AccountProvenance;
  /**
   * userId -> inviterId for accounts that are not themselves candidates. Two
   * supporters invited by two different people who were both invited by the
   * same person are one supporter, and the shared ancestor is usually not in
   * the candidate set, so the chain has to be followable past it.
   */
  inviterChain?: ReadonlyMap<string, string | null>;
}

export type IndependenceViolation =
  | 'shared_fingerprint'
  | 'shared_invite_chain'
  | 'creation_burst'
  | 'unverifiable_provenance';

export interface RejectedSupporter {
  userId: string;
  violation: IndependenceViolation;
}

export interface TwinComputation {
  status: TwinStatus;
  /**
   * INTERNAL ONLY. Carries cosine, reliability and weight, all of which are
   * numbers about people. Must not cross a network boundary. Empty whenever
   * status.enabled is false, so that a caller ignoring the status still cannot
   * render a twin.
   */
  links: TwinLink[];
  /** Audit trail for the independence check. Internal, useful when a demo says "why no twins". */
  rejected: RejectedSupporter[];
  /** Axis language description of the cluster. Null whenever the channel is off. */
  clusterDescriptor: string | null;
}

// ---------------------------------------------------------------------------
// Tuning that is local to twins. Anything shared lives in CONSTANTS.
// ---------------------------------------------------------------------------

/**
 * Accounts created inside this window of each other are treated as one actor.
 * Fifteen minutes is long enough to cover a scripted signup loop and short
 * enough that two strangers who happened to download the app the same evening
 * still count separately.
 */
const ACCOUNT_BURST_WINDOW_MS = 15 * 60 * 1000;

/** Guards against a malformed invite chain turning into an infinite walk. */
const INVITE_CHAIN_MAX_HOPS = 64;

/** An axis only describes the cluster if the whole cluster leans this hard on it. */
const SHARED_AXIS_MIN_MEAN = 0.5;

/** And if every single member leans the same way, not just the average. */
const SHARED_AXIS_MIN_MEMBER = 0.2;

/** Two axes is a description. Four is a horoscope. */
const MAX_DESCRIPTOR_AXES = 2;

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/**
 * Cosine over theta. Returns 0 when either vector has no magnitude.
 *
 * Direction rather than distance, because magnitude is mostly a function of how
 * many duels someone has played. A heavily shrunk new user and a settled user
 * with the same opinions must read as similar.
 */
export function cosineSimilarity(a: Vec24, b: Vec24): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < AXIS_COUNT; i++) {
    // Tolerate a short vector rather than throwing mid-demo. A missing axis is
    // an unknown opinion, which is what 0 means everywhere else in this system.
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

/**
 * Walk an account back to the root of its invite chain.
 *
 * An account nobody invited is its own root, so two organic accounts always get
 * two distinct roots. A cycle can only be fabricated data, so every member of
 * the cycle is collapsed onto one canonical id, which makes them dependent on
 * each other rather than making the walk hang.
 */
function inviteChainRoot(userId: string, chain: ReadonlyMap<string, string | null>): string {
  let current = userId;
  const visited = new Set<string>([current]);
  for (let hop = 0; hop < INVITE_CHAIN_MAX_HOPS; hop++) {
    const parent = chain.get(current) ?? null;
    if (parent === null) return current;
    if (visited.has(parent)) {
      const cycle = [...visited].sort();
      return cycle[0];
    }
    visited.add(parent);
    current = parent;
  }
  return current;
}

/**
 * An account we cannot date cannot be shown to be independent, and the whole
 * point of the check is that fabricated accounts look fine until you look at
 * their metadata. So a missing or unparseable createdAt fails closed.
 *
 * A missing fingerprint deliberately does NOT fail closed: zero-install
 * participants arrive through a message thread with no device row at all, and
 * excluding all of them would cost more real supporters than it blocks fake
 * ones. It is treated as no evidence of sharing, not as proof of independence.
 */
function creationTime(p: AccountProvenance): number | null {
  const t = Date.parse(p.createdAt ?? '');
  return Number.isFinite(t) ? t : null;
}

interface IndependenceSubject {
  userId: string;
  provenance: AccountProvenance;
  root: string;
}

/**
 * Why these two accounts cannot both count as supporters, or null if they can.
 *
 * `applyBurst` is off when comparing a candidate against the requesting user:
 * a genuine viral moment creates a cluster of signups around the person who
 * spread the link, and the fabrication signature we are actually looking for is
 * supporters correlating with EACH OTHER.
 */
function violationBetween(
  a: IndependenceSubject,
  b: IndependenceSubject,
  applyBurst: boolean,
): IndependenceViolation | null {
  if (
    a.provenance.fingerprint !== null &&
    a.provenance.fingerprint === b.provenance.fingerprint
  ) {
    return 'shared_fingerprint';
  }

  if (a.root === b.root) return 'shared_invite_chain';

  if (applyBurst) {
    const ta = creationTime(a.provenance);
    const tb = creationTime(b.provenance);
    if (ta !== null && tb !== null && Math.abs(ta - tb) < ACCOUNT_BURST_WINDOW_MS) {
      return 'creation_burst';
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

function buildInviterChain(input: TwinComputationInput): Map<string, string | null> {
  const chain = new Map<string, string | null>(input.inviterChain ?? []);
  // Candidate provenance wins over the supplied chain: it is the fresher read.
  for (const c of input.candidates) chain.set(c.userId, c.provenance.inviterId);
  if (input.selfProvenance) chain.set(input.self.userId, input.selfProvenance.inviterId);
  return chain;
}

function offStatus(reason: TwinStatus['reason'], twinCount: number): TwinComputation {
  return {
    status: { enabled: false, twinCount, reason },
    links: [],
    rejected: [],
    clusterDescriptor: null,
  };
}

/**
 * Compute the twin set for one user.
 *
 * Guarantees:
 *  - `status.enabled` is false unless the requester and every counted twin have
 *    at least MIN_DUELS_FOR_TWINS duels, at least K_FLOOR twins clear
 *    TWIN_COSINE_TAU with positive weight, and those twins are pairwise
 *    independent.
 *  - `links` is empty and `clusterDescriptor` is null whenever the channel is
 *    off, so a caller that ignores `status` still cannot render a twin.
 *  - No input field describes a friendship, and no output value is affected by
 *    who invited whom except by removal.
 */
export function computeTwins(input: TwinComputationInput): TwinComputation {
  const { self, candidates } = input;

  // Gate one. Our own vector has to mean something before we go looking for
  // people who match it. Matching on a shrunk near-prior theta finds the
  // population average and calls it a twin.
  if (self.nComparisons < CONSTANTS.MIN_DUELS_FOR_TWINS) {
    return offStatus('need_more_duels', 0);
  }

  const chain = buildInviterChain(input);

  // Gate two, applied per candidate. Symmetry matters: a twin whose own theta
  // is mostly prior would be endorsing dishes on the strength of ten duels.
  const eligible = candidates.filter(
    (c) => c.userId !== self.userId && c.nComparisons >= CONSTANTS.MIN_DUELS_FOR_TWINS,
  );

  const scored: TwinLink[] = [];
  for (const c of eligible) {
    const cosine = cosineSimilarity(self.theta, c.theta);
    if (cosine < CONSTANTS.TWIN_COSINE_TAU) continue;

    const reliability = Math.min(1, Math.max(0, c.reliability));
    const weight = cosine * reliability;
    // A zero-weight twin is a twin whose picks do not predict anything. Letting
    // one count toward k would make the floor clearable with pure noise.
    if (weight <= 0) continue;

    scored.push({ userId: self.userId, twinUserId: c.userId, cosine, reliability, weight });
  }

  return finish(input, chain, scored);
}

/**
 * Rank, then take supporters greedily in weight order, skipping any that is
 * entangled with one already taken. Greedy on weight keeps the strongest
 * supporter of each entangled group rather than an arbitrary one.
 */
function finish(
  input: TwinComputationInput,
  chain: Map<string, string | null>,
  scored: TwinLink[],
): TwinComputation {
  const byId = new Map(input.candidates.map((c) => [c.userId, c]));

  // Ties broken by id so the same population always produces the same twins.
  const ranked = [...scored].sort(
    (x, y) => y.weight - x.weight || x.twinUserId.localeCompare(y.twinUserId),
  );

  const accepted: TwinLink[] = [];
  const acceptedSubjects: IndependenceSubject[] = [];
  const rejected: RejectedSupporter[] = [];

  const selfSubject: IndependenceSubject | null = input.selfProvenance
    ? {
        userId: input.self.userId,
        provenance: input.selfProvenance,
        root: inviteChainRoot(input.self.userId, chain),
      }
    : null;

  for (const link of ranked) {
    const candidate = byId.get(link.twinUserId);
    if (!candidate) continue;

    const subject: IndependenceSubject = {
      userId: candidate.userId,
      provenance: candidate.provenance,
      root: inviteChainRoot(candidate.userId, chain),
    };

    if (creationTime(candidate.provenance) === null) {
      rejected.push({ userId: candidate.userId, violation: 'unverifiable_provenance' });
      continue;
    }

    // Burst is not applied against the requester, see violationBetween.
    const againstSelf = selfSubject ? violationBetween(subject, selfSubject, false) : null;
    if (againstSelf) {
      rejected.push({ userId: candidate.userId, violation: againstSelf });
      continue;
    }

    let violation: IndependenceViolation | null = null;
    for (const other of acceptedSubjects) {
      violation = violationBetween(subject, other, true);
      if (violation) break;
    }
    if (violation) {
      rejected.push({ userId: candidate.userId, violation });
      continue;
    }

    accepted.push(link);
    acceptedSubjects.push(subject);
  }

  // Hard rule 5. Below the floor there is no channel, and the reason given is
  // the same whether the population was thin or an astroturf ring collapsed to
  // one supporter. Telling an attacker which check they tripped is telling them
  // what to fix next.
  if (accepted.length < CONSTANTS.K_FLOOR) {
    return {
      status: { enabled: false, twinCount: accepted.length, reason: 'population_too_small' },
      links: [],
      rejected,
      clusterDescriptor: null,
    };
  }

  const thetas = accepted.map((l) => byId.get(l.twinUserId)!.theta);

  return {
    status: { enabled: true, twinCount: accepted.length },
    links: accepted,
    rejected,
    clusterDescriptor: clusterDescriptor(input.self.theta, thetas),
  };
}

// ---------------------------------------------------------------------------
// Cluster description. Axis language, never numbers about people.
// ---------------------------------------------------------------------------

/**
 * Some poles read as verbs rather than adjectives, so the generic template
 * would produce "want their bitterness avoids". Phrase those explicitly.
 */
const POLE_PHRASING: Record<string, (label: string) => string> = {
  never: (label) => `will not accept ${label}`,
  none: (label) => `want no ${label}`,
  avoids: (label) => `avoid ${label}`,
  'seeks out': (label) => `seek out ${label}`,
  welcome: (label) => `welcome ${label}`,
};

function axisPhrase(axisIdx: number, positive: boolean): string {
  const axis = AXES[axisIdx];
  const pole = positive ? axis.high : axis.low;
  const phrasing = POLE_PHRASING[pole];
  return phrasing ? phrasing(axis.label) : `want their ${axis.label} ${pole}`;
}

/**
 * Describe what defines this cluster in the language of the axes.
 *
 * Guarantees: contains no digits, no counts, no percentages, no identities. It
 * is a sentence fragment about taste, which is the only thing rule 1 allows us
 * to say about a group of people. Feeds EvidencePacket.twinSupport.
 *
 * An axis qualifies only when the requester and every twin lean the same way on
 * it. An axis where the group is split describes nobody, and a descriptor that
 * describes nobody is the thing that makes a recommender feel like a horoscope.
 */
export function clusterDescriptor(selfTheta: Vec24, twinThetas: Vec24[]): string {
  const members = [selfTheta, ...twinThetas];

  const qualifying: Array<{ idx: number; positive: boolean; strength: number }> = [];
  for (let i = 0; i < AXIS_COUNT; i++) {
    const values = members.map((m) => m[i] ?? 0);
    const positive = values[0] > 0;
    const agreed = values.every(
      (v) => (v > 0) === positive && Math.abs(v) >= SHARED_AXIS_MIN_MEMBER,
    );
    if (!agreed) continue;

    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    if (Math.abs(mean) < SHARED_AXIS_MIN_MEAN) continue;

    qualifying.push({ idx: i, positive, strength: Math.abs(mean) });
  }

  if (qualifying.length === 0) {
    // Honest fallback. The cluster is real, we just cannot name one axis that
    // carries it, and inventing one would be rule 2 by the back door.
    return 'people whose picks line up with yours without any one axis explaining it';
  }

  const phrases = qualifying
    .sort((a, b) => b.strength - a.strength || a.idx - b.idx)
    .slice(0, MAX_DESCRIPTOR_AXES)
    .map((q) => axisPhrase(q.idx, q.positive));

  return `people who, like you, ${phrases.join(' and ')}`;
}

// ---------------------------------------------------------------------------
// The client boundary
// ---------------------------------------------------------------------------

/**
 * The only twin shape a client may receive.
 *
 * The `never` fields are not decoration. Omitting reliability at each call site
 * is a convention, and conventions lose. Declaring the field as optional-never
 * makes any object that carries a reliability, cosine, weight or twin identity
 * fail to typecheck as this type, so the leak becomes a build error rather than
 * something a reviewer has to notice.
 *
 * twinUserIds is blocked for a second reason: hard rule 4. There is no path
 * from reading a recommendation to a person, and that starts with never
 * shipping the person's id.
 */
export interface ClientTwinView {
  status: TwinStatus;
  /** Axis language only. Null whenever the channel is off. */
  clusterDescriptor: string | null;
  reliability?: never;
  cosine?: never;
  weight?: never;
  twinUserIds?: never;
  links?: never;
}

/**
 * Strip a computation down to what a client may see.
 *
 * Guarantees: builds a fresh object literal rather than spreading, so no field
 * of TwinComputation can survive by accident, and returns nothing about twins
 * at all when the channel is off.
 */
export function toClientTwinView(computation: TwinComputation): ClientTwinView {
  if (!computation.status.enabled) {
    return {
      status: {
        enabled: false,
        twinCount: computation.status.twinCount,
        reason: computation.status.reason,
      },
      clusterDescriptor: null,
    };
  }
  return {
    status: { enabled: true, twinCount: computation.status.twinCount },
    clusterDescriptor: computation.clusterDescriptor,
  };
}

/**
 * Build the twinSupport block of an EvidencePacket, or undefined when the twin
 * channel did not fire.
 *
 * Hard rule 5 lives here as well as in computeTwins, because lift is measured
 * against a dish and is not known until this point: k >= K_FLOOR AND
 * lift > LIFT_DELTA, or the packet carries no twinSupport at all and the
 * renderer therefore cannot mention twins.
 */
export function twinSupportForPacket(
  computation: TwinComputation,
  lift: number,
): EvidencePacket['twinSupport'] | undefined {
  if (!computation.status.enabled) return undefined;
  if (computation.status.twinCount < CONSTANTS.K_FLOOR) return undefined;
  if (!(lift > CONSTANTS.LIFT_DELTA)) return undefined;
  if (computation.clusterDescriptor === null) return undefined;

  return {
    n: computation.status.twinCount,
    lift,
    kFloorMet: true,
    clusterDescriptor: computation.clusterDescriptor,
  };
}

export const __testing = {
  inviteChainRoot,
  violationBetween,
  ACCOUNT_BURST_WINDOW_MS,
};
