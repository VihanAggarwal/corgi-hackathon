/**
 * Supabase client tests. Track C.
 *
 * The subject is not "does createClient work", it is "can a service-role key
 * reach a browser". Every test below corresponds to a way that happens: a
 * client component importing the wrong accessor, a variable renamed with a
 * NEXT_PUBLIC_ prefix, or a cached client outliving the key it was built from.
 *
 * The module is re-imported per test through vi.resetModules(), because the
 * guard that matters runs at module evaluation and a cached module would only
 * ever be tested once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MANAGED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
];

const saved = new Map<string, string | undefined>();

const URL = 'https://example.supabase.co';
const ANON = 'anon-key-value-0000';
const SERVICE = 'service-role-key-value-0000';

/** Pretend a `window` exists, which is the only thing isBrowser() looks at. */
function simulateBrowser(): void {
  (globalThis as unknown as { window?: unknown }).window = { document: {} };
}

function clearBrowser(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

async function loadClient(): Promise<typeof import('./client')> {
  vi.resetModules();
  return import('./client');
}

beforeEach(() => {
  for (const name of MANAGED) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  clearBrowser();
});

afterEach(() => {
  for (const name of MANAGED) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearBrowser();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Import time
// ---------------------------------------------------------------------------

describe('import time', () => {
  it('does not throw with no credentials at all', async () => {
    // There is no .env.local yet and there may never be one before the demo.
    // An import-time throw here takes the whole app down, not just the db layer.
    await expect(loadClient()).resolves.toBeDefined();
  });

  it('reports both credential sets as absent rather than guessing', async () => {
    const db = await loadClient();
    expect(db.hasAnonCredentials()).toBe(false);
    expect(db.hasServiceRoleCredentials()).toBe(false);
  });

  it('throws at module evaluation when the service key has a NEXT_PUBLIC_ prefix', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = SERVICE;

    // This is the one environment worth dying for: the prefix means the value
    // is inlined into client JavaScript at build time.
    await expect(loadClient()).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('ignores an empty prefixed variable, which is what .env.example leaves behind', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = '';
    await expect(loadClient()).resolves.toBeDefined();
  });

  it('does not fire on ordinary public variables', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    await expect(loadClient()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The service-role boundary
// ---------------------------------------------------------------------------

describe('service-role client', () => {
  it('refuses to construct in a browser context even with a valid key', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const db = await loadClient();

    simulateBrowser();

    expect(() => db.getServiceClient()).toThrow(db.ServiceRoleInBrowserError);
    expect(() => db.getServiceClient()).toThrow(/server routes only/i);
  });

  it('reports no service credentials in a browser, so callers take the stub path', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const db = await loadClient();

    expect(db.hasServiceRoleCredentials()).toBe(true);
    simulateBrowser();
    expect(db.hasServiceRoleCredentials()).toBe(false);
  });

  it('refuses the browser before it looks at the environment', async () => {
    const db = await loadClient();
    simulateBrowser();

    // No key is set here. The error must still be the browser one: a caller
    // must not be able to tell whether a key exists by reading the message.
    expect(() => db.getServiceClient()).toThrow(db.ServiceRoleInBrowserError);
  });

  it('throws a config error, not a broken client, when the key is missing', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    const db = await loadClient();

    expect(() => db.getServiceClient()).toThrow(db.MissingSupabaseConfigError);
  });

  it('constructs lazily and reuses the instance', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const db = await loadClient();

    const first = db.getServiceClient();
    expect(first).toBeDefined();
    expect(db.getServiceClient()).toBe(first);
  });

  it('does not keep serving a client built from a rotated key', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const db = await loadClient();

    const first = db.getServiceClient();
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'rotated-service-role-key';
    expect(db.getServiceClient()).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// The anon client
// ---------------------------------------------------------------------------

describe('anon client', () => {
  it('constructs when the public variables are present', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    const db = await loadClient();

    expect(db.hasAnonCredentials()).toBe(true);
    const client = db.getAnonClient();
    expect(client).toBeDefined();
    expect(db.getAnonClient()).toBe(client);
  });

  it('is available in a browser context, unlike the service client', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    const db = await loadClient();

    simulateBrowser();
    expect(() => db.getAnonClient()).not.toThrow();
  });

  it('throws a config error rather than a half working client', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    const db = await loadClient();

    expect(() => db.getAnonClient()).toThrow(db.MissingSupabaseConfigError);
  });

  it('drops the cache on reset so a new environment is picked up', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    const db = await loadClient();

    const first = db.getAnonClient();
    db.resetSupabaseClients();
    expect(db.getAnonClient()).not.toBe(first);
  });
});
