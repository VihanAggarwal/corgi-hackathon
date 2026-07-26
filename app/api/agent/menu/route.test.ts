/**
 * Route tests for POST /api/agent/menu. Track C.
 *
 * These test the WIRING: does a malformed request get a 4xx with no stack
 * trace, does a well-formed request reach the pipeline and get a 2xx, does
 * the rate limiter actually bite. The pipeline's own behavior (honesty,
 * grounding, constraint filtering) is covered in integrations/vision, which
 * this file deliberately does not re-test.
 *
 * A real .env.local exists in this repo (it landed partway through this
 * build), so every request here forces RENDER_DRY_RUN so a test never turns
 * into a live network call regardless of what happens to be configured.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimits } from '../../../../lib/api/rate-limit';
import { POST } from './route';

const URL = 'http://localhost/api/agent/menu';

/** Five bytes of "hello", valid base64 and small enough to never hit the size cap. */
const TINY_BASE64 = 'aGVsbG8=';

function jsonRequest(body: unknown): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * A real .env.local landed in this repo partway through the build, with a
 * live ANTHROPIC_API_KEY. Left alone, these tests would make real network
 * calls: slow, flaky under sandboxed network access, and billed. Every test
 * in this file runs with credentials removed and RENDER_DRY_RUN forced, so
 * the route is always exercised against the deterministic stub path, exactly
 * as it will be for a judge with no keys configured at all. The "it goes live
 * automatically once a key exists" half of that contract is covered where the
 * key check actually lives, in core/anthropic-client and integrations/vision.
 */
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'MERGE_GATEWAY_BASE_URL', 'MERGE_GATEWAY_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};
let savedRenderDryRun: string | undefined;

beforeEach(() => {
  resetRateLimits();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  savedRenderDryRun = process.env.RENDER_DRY_RUN;
  process.env.RENDER_DRY_RUN = '1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
  if (savedRenderDryRun === undefined) delete process.env.RENDER_DRY_RUN;
  else process.env.RENDER_DRY_RUN = savedRenderDryRun;
});

describe('request validation', () => {
  it('rejects a body with no deviceId', async () => {
    const res = await POST(jsonRequest({ photo: { base64: TINY_BASE64 } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(body.error.field).toBe('deviceId');
  });

  it('rejects a body with no photo field', async () => {
    const res = await POST(jsonRequest({ deviceId: 'device-0001' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
    expect(body.error.field).toBe('photo');
  });

  it('rejects an empty photo.base64', async () => {
    const res = await POST(jsonRequest({ deviceId: 'device-0001', photo: { base64: '' } }));
    expect(res.status).toBe(400);
  });

  it('rejects a theta of the wrong length', async () => {
    const res = await POST(
      jsonRequest({ deviceId: 'device-0001', photo: { base64: TINY_BASE64 }, theta: [1, 2, 3] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.field).toBe('theta');
  });

  it('rejects a theta containing a non-finite number', async () => {
    const theta = new Array(24).fill(0);
    theta[3] = 'not a number';
    const res = await POST(jsonRequest({ deviceId: 'device-0001', photo: { base64: TINY_BASE64 }, theta }));
    expect(res.status).toBe(400);
  });

  it('rejects a body that is not JSON when no multipart content type is set', async () => {
    const res = await POST(
      new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('never returns a stack trace or an HTML error page', async () => {
    const res = await POST(jsonRequest({ deviceId: 'x' })); // too short, and no photo
    const text = await res.text();
    expect(text).not.toMatch(/<html/i);
    expect(text).not.toMatch(/\bat \S+:\d+:\d+/); // "at file.ts:12:3", a stack frame
    expect(text).not.toContain('node_modules');
  });
});

describe('a well-formed request reaches the pipeline', () => {
  it('returns 200 with the MenuOrderResult envelope for a JSON body', async () => {
    const res = await POST(
      jsonRequest({
        deviceId: 'device-0002',
        photo: { base64: TINY_BASE64, mediaType: 'image/jpeg' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = await res.json();
    expect(['ok', 'partial', 'unreadable', 'degraded']).toContain(body.status);
    expect(Array.isArray(body.picks)).toBe(true);
    expect(typeof body.constraintsAppliedCount).toBe('number');
    expect(body.read).toBeTruthy();
    expect(typeof body.read.itemsSeen).toBe('number');
    // No live credentials were exercised: RENDER_DRY_RUN forces the renderer
    // dry, and the read path with no real photo bytes degrades to the stub.
    expect(body.read.stub).toBe(true);
  });

  it('returns 200 for an equivalent multipart form-data body', async () => {
    const form = new FormData();
    form.set('deviceId', 'device-0003');
    form.set('venueName', 'Test Kitchen');
    form.set(
      'image',
      new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5])], 'menu.png', { type: 'image/png' }),
    );

    const res = await POST(new Request(URL, { method: 'POST', body: form }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.read.stub).toBe(true);
    expect(Array.isArray(body.picks)).toBe(true);
  });

  it('clamps an out-of-range maxPicks instead of rejecting the request', async () => {
    const res = await POST(
      jsonRequest({ deviceId: 'device-0004', photo: { base64: TINY_BASE64 }, maxPicks: 500 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.picks.length).toBeLessThanOrEqual(5);
  });
});

describe('rate limiting', () => {
  it('returns 429 with a retry-after header once a device exhausts its budget', async () => {
    const deviceId = 'device-rate-limited';
    const request = () =>
      jsonRequest({ deviceId, photo: { base64: TINY_BASE64 } });

    let last: Response | null = null;
    // LIMITS.agentMenu.capacity is 6: the 7th call in a burst must be refused.
    for (let i = 0; i < 7; i++) {
      last = await POST(request());
    }

    expect(last).not.toBeNull();
    expect(last!.status).toBe(429);
    const body = await last!.json();
    expect(body.error.code).toBe('rate_limited');
    expect(last!.headers.get('retry-after')).toBeTruthy();
  });

  it('does not throttle a different device sharing the same process', async () => {
    const busy = 'device-busy-one';
    for (let i = 0; i < 6; i++) {
      await POST(jsonRequest({ deviceId: busy, photo: { base64: TINY_BASE64 } }));
    }
    const res = await POST(jsonRequest({ deviceId: 'device-fresh-one', photo: { base64: TINY_BASE64 } }));
    expect(res.status).toBe(200);
  });
});
