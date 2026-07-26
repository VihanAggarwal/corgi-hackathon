/**
 * Photon scheduled-tick route tests. Track C.
 *
 * Proves the route actually fires sendDueFollowUps against the same store the
 * webhook route uses, and respects the same optional shared secret.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AXIS_COUNT } from '../../../../contracts/axes';
import type { Vec24 } from '../../../../contracts/types';
import { defaultAgentStore, resetDefaultAgentStore, scheduleFollowUp } from '../../../../integrations/photon/handlers';
import { resetTransport, resolveTransport, type StubTransport } from '../../../../integrations/photon/transport';
import { POST } from './route';

function zeros(): Vec24 {
  return new Array(AXIS_COUNT).fill(0);
}

function tickRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/agent/tick', { method: 'POST', headers });
}

beforeEach(() => {
  delete process.env.AGENT_WEBHOOK_SECRET;
  resetTransport();
  resetDefaultAgentStore();
});

afterEach(() => {
  delete process.env.AGENT_WEBHOOK_SECRET;
});

describe('POST /api/agent/tick', () => {
  it('sends every due follow-up through the resolved transport', async () => {
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    scheduleFollowUp(
      defaultAgentStore(),
      { conversationId: 'conv_tick_1', dishName: 'bibimbap', venueName: null, dishPhi: zeros(), theta: zeros(), nComparisons: 0 },
      () => past,
    );

    const res = await POST(tickRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number };
    expect(body).toEqual({ ok: true, sent: 1 });

    const transport = resolveTransport() as StubTransport;
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toBe('hows the bibimbap? out of 10');
  });

  it('sends nothing, and errors nothing, when no follow-up is due yet', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    scheduleFollowUp(
      defaultAgentStore(),
      { conversationId: 'conv_tick_2', dishName: 'the udon', venueName: null, dishPhi: zeros(), theta: zeros(), nComparisons: 0 },
      () => soon,
    );

    const res = await POST(tickRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: number };
    expect(body).toEqual({ ok: true, sent: 0 });
  });

  it('honors the shared secret when configured', async () => {
    process.env.AGENT_WEBHOOK_SECRET = 'tick-secret';
    const unauthorized = await POST(tickRequest());
    expect(unauthorized.status).toBe(401);

    const authorized = await POST(tickRequest({ 'x-agent-webhook-secret': 'tick-secret' }));
    expect(authorized.status).toBe(200);
  });
});
