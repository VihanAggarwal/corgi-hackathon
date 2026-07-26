/**
 * Photon inbound webhook. Track C.
 *
 * The App Router requires route handlers under app/api/**; see CLAUDE.md's
 * routing note. This file is thin on purpose: it turns a raw HTTP request
 * into a call into integrations/photon/handlers.ts and turns the result back
 * into a Response. Every decision about what the agent says or does lives in
 * that file, not here.
 *
 * A SHARED-SECRET GATE ON OUR OWN ROUTE, NOT A CLAIM ABOUT PHOTON'S
 * Photon's webhook signing scheme is unverified (see integrations/photon
 * /transport.ts), so this route does not attempt to check one: guessing a
 * signature header would be exactly the fabricated wire-format risk that
 * file exists to quarantine. AGENT_WEBHOOK_SECRET is ours: an optional shared
 * secret this deployment can require in a header, unrelated to whatever
 * Photon itself may or may not sign with. Unset, the route is open, which
 * matches "no API keys exist yet" and is the same posture transport.ts takes
 * toward every other credential in this feature.
 */

import { ApiError, jsonError, jsonOk } from '@/lib/api/errors';
import { takeToken } from '@/lib/api/rate-limit';
import { defaultAgentStore, handleInboundMessage } from '@/integrations/photon/handlers';
import { resolveTransport } from '@/integrations/photon/transport';

// ---------------------------------------------------------------------------
// Rate limiting
//
// Local to this route rather than added to lib/api/rate-limit.ts's shared
// LIMITS table, because that table is budgeted around device-scoped consumer
// routes and a webhook has a different caller shape entirely: one sender
// (Photon), keyed by conversation so one noisy thread cannot starve another.
// ---------------------------------------------------------------------------

const WEBHOOK_LIMIT = { capacity: 20, refillPerSecond: 0.5 } as const;

function webhookSecret(): string {
  return (process.env.AGENT_WEBHOOK_SECRET ?? '').trim();
}

function isAuthorized(request: Request): boolean {
  const configured = webhookSecret();
  if (configured.length === 0) return true; // open until a secret is configured
  const header = request.headers.get('x-agent-webhook-secret') ?? '';
  return header === configured;
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!isAuthorized(request)) {
      throw new ApiError('unauthorized', 'Missing or incorrect webhook secret.');
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ApiError('invalid_body', 'Body must be JSON.');
    }

    const transport = resolveTransport();
    const message = transport.receive(raw);
    if (!message) {
      // Not every retry or probe from a webhook provider is a real message.
      // A 200 here (rather than a 400) is deliberate: telling Photon "this
      // shape is wrong" for every ping-style payload it might send would
      // train it to stop delivering, and the payload was never guessed to
      // begin with, so there is nothing to validate it against.
      return jsonOk({ ok: true, handled: false });
    }

    const limit = takeToken(`agent-webhook|${message.conversation.id}`, WEBHOOK_LIMIT);
    if (!limit.allowed) {
      throw new ApiError('rate_limited', 'Too many messages from this conversation.');
    }

    const sent = await handleInboundMessage(message, { transport, store: defaultAgentStore() });
    return jsonOk({ ok: true, handled: true, sent: sent.length });
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err);
    // Anything else is a bug, not a caller mistake, and its message may carry
    // request internals. Never hand it back verbatim.
    return jsonError(new ApiError('internal', 'The webhook could not process that message.'));
  }
}
