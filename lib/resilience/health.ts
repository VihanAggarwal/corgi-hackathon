/**
 * Dependency health probes. Track C.
 *
 * WHAT THIS ROUTE IS FOR
 * A presenter standing at a demo table with dead wifi needs one glance to know
 * which parts of the system are real right now and which have quietly gone to
 * their fallback. This module is that glance. It probes every external
 * dependency, gives each one a short independent deadline, and never lets a
 * hung probe or a hung vendor turn a health check into the thing that is down.
 *
 * CONFIGURED VS REACHABLE, AND WHY BOTH MATTER
 * "Not configured" and "configured but unreachable" are different facts and
 * read very differently to a presenter. The first means "we have not wired
 * this up," which is expected and fine to say out loud. The second means
 * "this should work and does not right now," which is the wifi story. Collapsing
 * them into one boolean would make every missing API key look like an outage.
 *
 * WHAT A REACHABILITY PROBE DOES NOT DO
 * It does not spend a paid model call, does not run Merge's MCP handshake
 * against the real vendor (which would also write into their audit log on
 * every health check), and does not place a live Places search. Every probe
 * here is network-level: it opens a connection to the dependency's host with a
 * short timeout and treats any HTTP response, success or error, as reachable.
 * Only a transport failure (DNS, timeout, connection refused) counts as
 * unreachable. That is a deliberately weaker claim than "the credential is
 * valid," and it is the right one for a route that has to answer for free,
 * constantly, and without touching anyone's quota.
 *
 * BOUNDED, TWICE
 * Every probe runs through withFallback from ./call, which gives it its own
 * timeout and turns a failure into a degraded result rather than a throw. On
 * top of that, the whole batch is raced against an overall budget, so a probe
 * that somehow ignores its own deadline (a bug, not the expected case) still
 * cannot make this route hang. See withOverallBudget.
 */

import {
  hasAnonCredentials,
  hasServiceRoleCredentials,
  getAnonClient,
  getServiceClient,
} from '../db';
import { anthropicClientOptions, hasModelCredentials } from '../../core';
import { hasPhotonCredentials } from '../../integrations/photon/transport';
import { withFallback } from './call';
import { recentDegradations, type DegradedNotice } from './degradation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DependencyName = 'database' | 'anthropic' | 'places' | 'merge' | 'photon';

export type DependencyStatus = 'ok' | 'unreachable' | 'not_configured';

export interface DependencyHealth {
  name: DependencyName;
  configured: boolean;
  /** null only when configured is false: an unconfigured dependency is never probed. */
  reachable: boolean | null;
  status: DependencyStatus;
  /** Safe to show. Never a raw exception message; see ./degradation redact(). */
  detail: string;
  latencyMs: number | null;
}

export interface HealthReport {
  /** True only when every configured dependency answered. Never false because a key is missing. */
  ok: boolean;
  dependencies: DependencyHealth[];
  /** Recent fallbacks from the whole process, not just this request's probes. */
  degradations: DegradedNotice[];
  checkedAt: string;
  elapsedMs: number;
}

type Probe = (signal: AbortSignal) => Promise<string>;

export interface HealthOptions {
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-dependency deadline. */
  timeoutMs?: number;
  /** Ceiling for the whole report, independent of any single probe's timeout. */
  overallBudgetMs?: number;
  now?: () => number;
  /** Test seam: replace one or more probes wholesale, e.g. with a promise that never settles. */
  probeOverrides?: Partial<Record<DependencyName, Probe>>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const DEFAULT_OVERALL_BUDGET_MS = 4000;

// ---------------------------------------------------------------------------
// Individual probes. Each returns a short success detail, or throws, and
// nothing here catches: withFallback in probeDependency() is what turns a
// throw into a degraded, observable result.
// ---------------------------------------------------------------------------

/**
 * A one-row Supabase read. Cheap, uses no quota beyond what the project
 * already pays for, and exercises the same client construction path the rest
 * of the app uses, so a health check that passes means the credentials the
 * app actually uses are the ones that work.
 */
async function checkDatabase(signal: AbortSignal): Promise<string> {
  const client = hasServiceRoleCredentials() ? getServiceClient() : getAnonClient();
  const { error } = await client.from('venues').select('id').limit(1).abortSignal(signal);
  if (error) throw new Error('Supabase query failed.');
  return 'query succeeded';
}

/**
 * Anthropic's model list endpoint. Metadata only, no generation, so a health
 * check run every few seconds during a demo does not burn tokens.
 */
async function checkAnthropic(signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const { apiKey, baseURL } = anthropicClientOptions();
  const base = baseURL && baseURL.trim().length > 0 ? baseURL.replace(/\/+$/, '') : 'https://api.anthropic.com';
  const res = await fetchImpl(`${base}/v1/models?limit=1`, {
    method: 'GET',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal,
  });
  return `responded ${res.status}`;
}

/**
 * Google's public discovery document for the Places API. Reachable with no
 * key at all, so this proves the network path to Google's API host without
 * spending a single billed Places request on a health check.
 */
async function checkPlaces(signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl('https://places.googleapis.com/$discovery/rest?version=v1', {
    method: 'GET',
    signal,
  });
  return `responded ${res.status}`;
}

/** Origin of the configured Merge Agent Handler URL, or Merge's API host if none is set. */
function mergeProbeOrigin(): string {
  const configured = (process.env.MERGE_AGENT_HANDLER_URL ?? '').trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the default host below.
    }
  }
  return 'https://api.merge.dev';
}

/**
 * A bare request to Merge's host. Deliberately not the MCP handshake from
 * integrations/hris/agent-handler.ts: that call is a real tool invocation
 * against a vendor that keeps an audit trail, and firing it on every health
 * check would write "employee list requested" into that trail once per poll.
 * This checks the network path only.
 */
async function checkMerge(signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(mergeProbeOrigin(), { method: 'GET', signal });
  return `responded ${res.status}`;
}

/** Origin of the configured Photon send URL. */
function photonProbeOrigin(): string {
  const configured = (process.env.PHOTON_SEND_URL ?? '').trim();
  try {
    return new URL(configured).origin;
  } catch {
    return configured;
  }
}

async function checkPhoton(signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const origin = photonProbeOrigin();
  if (origin.length === 0) throw new Error('PHOTON_SEND_URL is not a valid URL.');
  const res = await fetchImpl(origin, { method: 'GET', signal });
  return `responded ${res.status}`;
}

// ---------------------------------------------------------------------------
// One probe, wrapped
// ---------------------------------------------------------------------------

/**
 * Run one dependency's probe through the resilience wrapper.
 *
 * Guarantees: never throws. An unconfigured dependency is reported without
 * attempting a call at all, which is what keeps a missing API key from ever
 * reading as a failure. A configured dependency always gets exactly one
 * attempt (no retry: a health route polled every few seconds should not
 * double its own network load) bounded by `timeoutMs`.
 */
async function probeDependency(
  name: DependencyName,
  configured: boolean,
  timeoutMs: number,
  check: Probe,
): Promise<DependencyHealth> {
  if (!configured) {
    return {
      name,
      configured: false,
      reachable: null,
      status: 'not_configured',
      detail: 'no credentials configured',
      latencyMs: null,
    };
  }

  const outcome = await withFallback<string>(
    check,
    (notice) => `unreachable: ${notice.detail}`,
    {
      dependency: name,
      timeoutMs,
      attempts: 1,
      budgetMs: timeoutMs + 500,
    },
  );

  return {
    name,
    configured: true,
    reachable: !outcome.degraded,
    status: outcome.degraded ? 'unreachable' : 'ok',
    detail: outcome.value,
    latencyMs: outcome.elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// The overall budget backstop
// ---------------------------------------------------------------------------

/**
 * Race a promise against a hard deadline, resolving to `onTimeout()` if the
 * deadline wins.
 *
 * This is deliberately independent of any timeout inside `promise`. Every
 * individual probe already bounds itself through withFallback, so under normal
 * operation this race never fires; it exists as a backstop against a probe
 * that has a bug and ignores its own deadline; without it a fully bugged probe
 * for every dependency would be the one way this route could still hang.
 *
 * The losing side is not cancelled, only abandoned: `promise` may keep running
 * after `onTimeout()` wins, exactly as withTimeout in ./call abandons a socket
 * it cannot force closed. Nothing awaits it further, so it cannot delay the
 * response a second time.
 */
async function withOverallBudget<T>(promise: Promise<T>, budgetMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), budgetMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check every external dependency's configured/reachable state.
 *
 * Guarantees:
 *  - Never throws and never rejects. Every failure mode below the network
 *    layer becomes a DependencyHealth entry, not an exception.
 *  - Settles within roughly `overallBudgetMs` regardless of how long any
 *    individual probe takes, including a probe that never settles at all.
 *  - A dependency with no credentials reports status 'not_configured' and is
 *    never probed over the network.
 *  - `ok` is true exactly when no configured dependency came back
 *    unreachable; an unconfigured dependency never lowers it, because running
 *    this demo with some integrations unset is the expected state, not a
 *    failure of the route.
 */
export async function checkHealth(options: HealthOptions = {}): Promise<HealthReport> {
  const now = options.now ?? Date.now;
  const start = now();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const overallBudgetMs = options.overallBudgetMs ?? DEFAULT_OVERALL_BUDGET_MS;

  const specs: Array<{ name: DependencyName; configured: boolean; check: Probe }> = [
    {
      name: 'database',
      configured: hasAnonCredentials() || hasServiceRoleCredentials(),
      check: (signal) => checkDatabase(signal),
    },
    {
      name: 'anthropic',
      configured: hasModelCredentials(),
      check: (signal) => checkAnthropic(signal, fetchImpl),
    },
    {
      name: 'places',
      configured: (process.env.GOOGLE_PLACES_API_KEY ?? '').trim().length > 0,
      check: (signal) => checkPlaces(signal, fetchImpl),
    },
    {
      name: 'merge',
      configured: (process.env.MERGE_AGENT_HANDLER_API_KEY ?? '').trim().length > 0,
      check: (signal) => checkMerge(signal, fetchImpl),
    },
    {
      name: 'photon',
      configured: hasPhotonCredentials(),
      check: (signal) => checkPhoton(signal, fetchImpl),
    },
  ];

  const probes = Promise.all(
    specs.map((spec) => probeDependency(spec.name, spec.configured, timeoutMs, options.probeOverrides?.[spec.name] ?? spec.check)),
  );

  const dependencies = await withOverallBudget(probes, overallBudgetMs, () =>
    specs.map((spec) => timedOutDependency(spec.name, spec.configured)),
  );

  return {
    ok: dependencies.every((d) => d.status !== 'unreachable'),
    dependencies,
    degradations: recentDegradations(10),
    checkedAt: new Date(start).toISOString(),
    elapsedMs: now() - start,
  };
}

/** What a dependency reports when the overall budget backstop had to fire. */
function timedOutDependency(name: DependencyName, configured: boolean): DependencyHealth {
  if (!configured) {
    return { name, configured: false, reachable: null, status: 'not_configured', detail: 'no credentials configured', latencyMs: null };
  }
  return {
    name,
    configured: true,
    reachable: false,
    status: 'unreachable',
    detail: 'exceeded the health route overall budget',
    latencyMs: null,
  };
}

export const __testing = { checkDatabase, checkAnthropic, checkPlaces, checkMerge, checkPhoton, withOverallBudget };
