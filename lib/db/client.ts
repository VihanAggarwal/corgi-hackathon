/**
 * Supabase clients. Track C.
 *
 * Two clients, and the distinction is load-bearing rather than stylistic.
 *
 *   anon     RLS applies. Safe for anything a browser touches. The policies in
 *            contracts/schema.sql are the enforcement, this key is only an
 *            identity.
 *   service  RLS is bypassed. It can read every row of `constraints` and
 *            `reliability`, which are Article 9 data and numbers about people
 *            respectively. It exists so server routes can run the constraint
 *            filter and the twin computation, and for nothing else.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT
 * A service-role key in a client bundle is not a leak of one secret, it is a
 * public read of every dietary and religious record in the database, for
 * everyone, forever, from a browser devtools tab. Two things make that hard
 * here: the key is read only from a non-NEXT_PUBLIC_ variable, and the
 * service-role accessor refuses to construct anything when a `window` exists.
 *
 * WHY THE PREFIX IS THE WHOLE GAME
 * Next inlines the literal text of `process.env.NEXT_PUBLIC_*` into the client
 * JavaScript at build time. Renaming SUPABASE_SERVICE_ROLE_KEY to
 * NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY would not "expose it to the frontend",
 * it would paste it into a file served to every visitor. Non-prefixed variables
 * resolve to undefined in the browser, which is why the service key is read
 * from one, and why the module-scope guard below fails the build the moment a
 * prefixed spelling of it appears anywhere in the environment.
 *
 * EVERYTHING CONSTRUCTS LAZILY
 * There are no credentials yet. Nothing in this module may throw at import
 * time for a missing variable, because the app has to build, boot, run its
 * tests and demo without any. Callers ask `hasAnonCredentials()` /
 * `hasServiceRoleCredentials()` and degrade to a stub path when the answer is
 * false. The only import-time throw is the one that catches an actively
 * dangerous environment, which is a different thing from a missing one.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Errors. Distinct types, because one of these is a config gap and the other
// two are security incidents, and a caller may reasonably swallow only the first.
// ---------------------------------------------------------------------------

/** Thrown when a client is requested and its environment variables are absent. */
export class MissingSupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingSupabaseConfigError';
  }
}

/** Thrown when the service-role client is requested from a browser context. */
export class ServiceRoleInBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceRoleInBrowserError';
  }
}

/** Thrown at module evaluation when the environment would ship the key to clients. */
export class ServiceRoleExposedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceRoleExposedError';
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Whether this code is running somewhere a user can open devtools.
 *
 * Checked at call time rather than captured in a module constant so that a test
 * can simulate a browser, and so that a bundler cannot fold the check away.
 */
function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Any environment variable that would publish a service-role credential.
 *
 * Matched on the NAME, not the value, because the name is what decides whether
 * a bundler inlines it. SERVICE_KEY is included because that is what the same
 * secret is called in half the Supabase examples on the internet.
 */
const PUBLIC_SERVICE_ROLE_NAME_RE = /^NEXT_PUBLIC_.*(SERVICE_ROLE|SERVICEROLE|SERVICE_KEY)/i;

/**
 * Fail if the environment carries a publicly-prefixed service-role key.
 *
 * Guarantees: throws ServiceRoleExposedError naming the offending variable, and
 * does nothing at all when the environment is merely empty. Runs at module
 * evaluation on both the server and the client, so the deploy dies rather than
 * the secret shipping. Exported so it can be tested directly.
 */
export function assertServiceRoleNotPublic(): void {
  // In a client bundle `process` may not exist at all. That is the safe case.
  if (typeof process === 'undefined' || !process.env) return;

  for (const name of Object.keys(process.env)) {
    if (!PUBLIC_SERVICE_ROLE_NAME_RE.test(name)) continue;
    if (!process.env[name]) continue;
    throw new ServiceRoleExposedError(
      `${name} is set. A NEXT_PUBLIC_ prefix inlines the value into client JavaScript, ` +
        `which would publish read access to every constraints and reliability row. ` +
        `Rename it to SUPABASE_SERVICE_ROLE_KEY.`,
    );
  }
}

assertServiceRoleNotPublic();

// ---------------------------------------------------------------------------
// Environment reads
// ---------------------------------------------------------------------------

/**
 * The two public variables are read as literal member expressions on purpose.
 * Next substitutes the literal text `process.env.NEXT_PUBLIC_SUPABASE_URL` at
 * build time and does not substitute `process.env[name]`, so a dynamic read
 * here would silently produce undefined in the browser.
 */
function readPublicUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
}

function readAnonKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
}

/**
 * Server-only variable. Undefined in every browser bundle by construction,
 * which is the property the whole file is built around.
 */
function readServiceRoleKey(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
}

/** Whether an anon (RLS-respecting) client can be constructed right now. */
export function hasAnonCredentials(): boolean {
  return Boolean(readPublicUrl() && readAnonKey());
}

/**
 * Whether a service-role client can be constructed right now.
 *
 * False in a browser regardless of the environment, so a caller branching on
 * this degrades to the stub path instead of hitting the thrown error.
 */
export function hasServiceRoleCredentials(): boolean {
  if (isBrowser()) return false;
  return Boolean(readPublicUrl() && readServiceRoleKey());
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

interface CachedClient {
  /** Identity of the environment the cached client was built from. */
  signature: string;
  client: SupabaseClient;
}

let anonCache: CachedClient | null = null;
let serviceCache: CachedClient | null = null;

/**
 * The cache key is derived from the credentials rather than being a bare
 * boolean, so a process that gains or rotates a key mid-run does not keep
 * handing out a client built from the old one. Only the first characters of the
 * key are used: a full key in a cache key is a full key in a heap dump.
 */
function signature(url: string, key: string): string {
  return `${url}#${key.length}#${key.slice(0, 8)}`;
}

/**
 * The anon client. RLS applies to everything it does.
 *
 * Guarantees: constructed on first call and never at import time, reused across
 * calls, and throws MissingSupabaseConfigError rather than returning a half
 * working client when the public variables are absent. Safe in the browser.
 */
export function getAnonClient(): SupabaseClient {
  const url = readPublicUrl();
  const key = readAnonKey();
  if (!url || !key) {
    throw new MissingSupabaseConfigError(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required. ' +
        'Check hasAnonCredentials() first and use the stub path when it is false.',
    );
  }

  const sig = signature(url, key);
  if (anonCache && anonCache.signature === sig) return anonCache.client;

  const client = createClient(url, key, {
    auth: {
      // Session storage is a browser concern. On the server it would write a
      // session into whatever storage shim is present and share it across
      // requests, which is one user's session serving another user's request.
      persistSession: isBrowser(),
      autoRefreshToken: isBrowser(),
    },
  });
  anonCache = { signature: sig, client };
  return client;
}

/**
 * The service-role client. Bypasses RLS. Server routes only.
 *
 * Guarantees: throws ServiceRoleInBrowserError before touching the environment
 * when a `window` exists, so no browser code path can obtain one even if a key
 * somehow reached the bundle. Otherwise constructed lazily, cached, and never
 * at import time. Throws MissingSupabaseConfigError when the key is absent.
 */
export function getServiceClient(): SupabaseClient {
  if (isBrowser()) {
    throw new ServiceRoleInBrowserError(
      'getServiceClient() was called in a browser context. The service role key ' +
        'bypasses row level security on constraints and reliability. Server routes only.',
    );
  }

  const url = readPublicUrl();
  const key = readServiceRoleKey();
  if (!url || !key) {
    throw new MissingSupabaseConfigError(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. ' +
        'Check hasServiceRoleCredentials() first and use the stub path when it is false.',
    );
  }

  const sig = signature(url, key);
  if (serviceCache && serviceCache.signature === sig) return serviceCache.client;

  const client = createClient(url, key, {
    auth: {
      // A service-role client has no user, so a persisted session is at best
      // meaningless and at worst a cross-request identity.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  serviceCache = { signature: sig, client };
  return client;
}

/**
 * Drop both cached clients.
 *
 * Guarantees: the next accessor call re-reads the environment. Exists for tests
 * that mutate process.env, and for a key rotation during a long-lived process.
 */
export function resetSupabaseClients(): void {
  anonCache = null;
  serviceCache = null;
}
