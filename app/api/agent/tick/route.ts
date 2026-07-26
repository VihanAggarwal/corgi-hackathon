/**
 * Fires every follow-up whose two hours are up. Track C.
 *
 * Nothing in this process wakes itself up two hours after a recommendation,
 * so something external has to call this on a timer (Vercel Cron or an
 * equivalent scheduler configured outside this repo). This route is the
 * thin thing that timer hits; sendDueFollowUps in integrations/photon
 * /handlers.ts is where the actual work happens and where it is tested.
 *
 * Not part of the four files the Track C prompt named for the agent layer.
 * Added because "send the follow-up two hours later" has no other caller
 * anywhere in the app, and a mechanism nothing invokes does not ship a
 * feature. See the Track C report for this call.
 */

import { ApiError, jsonError, jsonOk } from '@/lib/api/errors';
import { defaultAgentStore, sendDueFollowUps } from '@/integrations/photon/handlers';
import { resolveTransport } from '@/integrations/photon/transport';

function tickSecret(): string {
  return (process.env.AGENT_WEBHOOK_SECRET ?? '').trim();
}

function isAuthorized(request: Request): boolean {
  const configured = tickSecret();
  if (configured.length === 0) return true;
  const header = request.headers.get('x-agent-webhook-secret') ?? '';
  return header === configured;
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!isAuthorized(request)) {
      throw new ApiError('unauthorized', 'Missing or incorrect scheduler secret.');
    }
    const sent = await sendDueFollowUps(defaultAgentStore(), resolveTransport());
    return jsonOk({ ok: true, sent: sent.length });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err);
    return jsonError(new ApiError('internal', 'The scheduled tick could not run.'));
  }
}
