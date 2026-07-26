/**
 * Tests for the dependency health checker. Track C.
 *
 * Three properties matter here and each gets its own block: a missing key
 * reads as 'not_configured' rather than a failure, a real probe failure reads
 * as 'unreachable' and is visible, and the whole report is bounded even when
 * every probe hangs forever.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHealth, type DependencyName } from './health';

const MANAGED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'MERGE_GATEWAY_BASE_URL',
  'GOOGLE_PLACES_API_KEY',
  'MERGE_AGENT_HANDLER_API_KEY',
  'MERGE_AGENT_HANDLER_URL',
  'PHOTON_API_KEY',
  'PHOTON_SEND_URL',
];

const saved = new Map<string, string | undefined>();

function clearAllEnv(): void {
  for (const name of MANAGED_ENV) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
}

function configureEverything(): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-value';
  process.env.GOOGLE_PLACES_API_KEY = 'places-test-value';
  process.env.MERGE_AGENT_HANDLER_API_KEY = 'merge-test-value';
  process.env.PHOTON_API_KEY = 'photon-test-value';
  process.env.PHOTON_SEND_URL = 'https://photon.example.com/send';
}

beforeEach(() => {
  clearAllEnv();
});

afterEach(() => {
  for (const name of MANAGED_ENV) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function neverSettles(): Promise<string> {
  return new Promise<string>(() => {
    /* deliberately hangs */
  });
}

describe('checkHealth: missing credentials', () => {
  it('reports not_configured rather than failing when nothing is set', async () => {
    const report = await checkHealth();

    expect(report.dependencies).toHaveLength(5);
    for (const dep of report.dependencies) {
      expect(dep.status).toBe('not_configured');
      expect(dep.configured).toBe(false);
      expect(dep.reachable).toBeNull();
    }
    // An empty environment is the expected hackathon state, not an outage.
    expect(report.ok).toBe(true);
  });

  it('never makes a network call for an unconfigured dependency', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error('should never be called');
    }) as unknown as typeof fetch;

    await checkHealth({ fetchImpl });
    expect(fetchCalls).toBe(0);
  });
});

describe('checkHealth: a real probe failure', () => {
  it('reports unreachable and surfaces the reason when a configured dependency fails', async () => {
    configureEverything();

    const report = await checkHealth({
      probeOverrides: {
        anthropic: async () => {
          throw new Error('connection refused');
        },
      },
    });

    const anthropic = report.dependencies.find((d) => d.name === 'anthropic')!;
    expect(anthropic.configured).toBe(true);
    expect(anthropic.reachable).toBe(false);
    expect(anthropic.status).toBe('unreachable');
    expect(anthropic.detail.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it('reports ok for a configured dependency whose probe succeeds', async () => {
    configureEverything();

    const report = await checkHealth({
      probeOverrides: {
        database: async () => 'query succeeded',
        anthropic: async () => 'responded 200',
        places: async () => 'responded 200',
        merge: async () => 'responded 200',
        photon: async () => 'responded 200',
      },
    });

    expect(report.dependencies.every((d) => d.status === 'ok')).toBe(true);
    expect(report.ok).toBe(true);
  });
});

describe('checkHealth: bounded even when every probe hangs', () => {
  it('respects the per-probe timeout for a single hung dependency', async () => {
    configureEverything();
    const start = Date.now();

    const report = await checkHealth({
      timeoutMs: 40,
      overallBudgetMs: 5000,
      probeOverrides: {
        // Isolate the dependency under test. Left as real network calls,
        // these would be bounded by the same timeout but would make this
        // test's timing depend on the sandbox's network policy.
        database: async () => 'query succeeded',
        anthropic: async () => 'responded 200',
        places: async () => 'responded 200',
        merge: async () => 'responded 200',
        photon: () => neverSettles(),
      },
    });

    const photon = report.dependencies.find((d) => d.name === 'photon')!;
    expect(photon.status).toBe('unreachable');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('never exceeds the overall budget even when every probe hangs and ignores its own timeout', async () => {
    configureEverything();
    const start = Date.now();
    const hangingProbes: Partial<Record<DependencyName, () => Promise<string>>> = {
      database: () => neverSettles(),
      anthropic: () => neverSettles(),
      places: () => neverSettles(),
      merge: () => neverSettles(),
      photon: () => neverSettles(),
    };

    const report = await checkHealth({
      // A per-probe timeout deliberately larger than the overall budget,
      // simulating a probe that would otherwise hang well past what the route
      // is allowed to take. The overall budget backstop, not the per-probe
      // timeout, is what has to save this call. Kept well under a second so
      // the abandoned probes (see withOverallBudget's doc comment) do not
      // leave a long-lived timer behind after the test finishes.
      timeoutMs: 400,
      overallBudgetMs: 60,
      probeOverrides: hangingProbes,
    });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(350);
    for (const dep of report.dependencies) {
      expect(dep.status).toBe('unreachable');
      expect(dep.reachable).toBe(false);
    }
    expect(report.ok).toBe(false);
  });
});
