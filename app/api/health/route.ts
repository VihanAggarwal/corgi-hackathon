/**
 * GET /api/health. Track C.
 *
 * Thin on purpose: everything that decides what "healthy" means lives in
 * lib/resilience/health.ts, so this file has nothing to unit test that the
 * lib layer does not already cover. Its only job is to hand the report back
 * as JSON without ever throwing, because a health route that 500s is the one
 * failure mode this endpoint exists to rule out.
 *
 * Always 200. A degraded dependency is data in the body (`ok: false`,
 * per-dependency `status`), not an HTTP failure: a monitor or a presenter
 * reading this during a demo needs to see WHICH dependency is down, and a
 * bare 503 would tell them only that something, somewhere, is not fine.
 */

import { checkHealth } from '@/lib/resilience';
import { jsonOk } from '@/lib/api/errors';

export async function GET(): Promise<Response> {
  try {
    const report = await checkHealth();
    return jsonOk(report);
  } catch {
    // checkHealth is documented to never throw. This catch exists anyway,
    // because a health route that can still 500 defeats its own purpose, and
    // "the thing that documents downtime went down" is not a state worth
    // risking to save one try/catch.
    return jsonOk(
      {
        ok: false,
        dependencies: [],
        degradations: [],
        checkedAt: new Date().toISOString(),
        elapsedMs: 0,
        error: 'health check failed unexpectedly',
      },
      200,
    );
  }
}
