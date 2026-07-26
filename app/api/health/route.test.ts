/**
 * Smoke test for GET /api/health. Track C.
 *
 * The route itself has almost no logic (see route.ts's own doc comment), so
 * this only checks the shape a client actually depends on: always 200, always
 * JSON, always the five dependencies, and fast in the common no-credentials
 * case that this repo runs in today.
 */

import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/health', () => {
  it('returns 200 with a report naming all five dependencies', async () => {
    const start = Date.now();
    const res = await GET();
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(typeof body.ok).toBe('boolean');
    expect(Array.isArray(body.dependencies)).toBe(true);
    expect(body.dependencies.map((d: { name: string }) => d.name).sort()).toEqual([
      'anthropic',
      'database',
      'merge',
      'photon',
      'places',
    ]);
    expect(typeof body.checkedAt).toBe('string');

    // No credentials are configured in this repo yet, so every dependency
    // should answer near-instantly without a single real network attempt.
    expect(elapsed).toBeLessThan(2000);
  });

  it('never sets a shared cache header, since a health report is per-request truth', async () => {
    const res = await GET();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
