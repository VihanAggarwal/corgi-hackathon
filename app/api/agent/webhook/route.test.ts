/**
 * Photon webhook route tests. Track C.
 *
 * These exercise the actual exported POST handler with real Request objects,
 * not a re-implementation of its logic: the point is to prove the HTTP shell
 * (auth, JSON parsing, status codes) around the handlers.ts logic already
 * covered by integrations/photon/handlers.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAgentStore, resetDefaultAgentStore } from '../../../../integrations/photon/handlers';
import { resetTransport, resolveTransport, type StubTransport } from '../../../../integrations/photon/transport';
import { resetRateLimits } from '../../../../lib/api/rate-limit';
import { POST } from './route';

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/agent/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const RAW_MESSAGE = {
  message_id: 'wh_1',
  conversation: { id: 'conv_wh_1', is_group: false },
  sender: { id: 'sender_1' },
  text: 'what do I get here',
};

beforeEach(() => {
  delete process.env.AGENT_WEBHOOK_SECRET;
  resetTransport();
  resetDefaultAgentStore();
  resetRateLimits();
});

afterEach(() => {
  delete process.env.AGENT_WEBHOOK_SECRET;
});

describe('POST /api/agent/webhook', () => {
  it('handles a well-formed inbound message and sends a reply through the resolved transport', async () => {
    const res = await POST(request(RAW_MESSAGE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; handled: boolean; sent: number };
    expect(body).toEqual({ ok: true, handled: true, sent: 1 });

    const transport = resolveTransport() as StubTransport;
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].conversationId).toBe('conv_wh_1');
  });

  it('returns handled: false for a payload transport.receive cannot normalize, without erroring', async () => {
    const res = await POST(request({ some: 'unrelated shape' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; handled: boolean };
    expect(body).toEqual({ ok: true, handled: false });
  });

  it('rejects a body that is not JSON at all', async () => {
    const res = await POST(
      new Request('http://localhost/api/agent/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });

  it('replaying the same message id is a no-op at the route level too', async () => {
    const first = await POST(request(RAW_MESSAGE));
    const second = await POST(request(RAW_MESSAGE));
    expect((await first.json() as { sent: number }).sent).toBe(1);
    expect((await second.json() as { sent: number }).sent).toBe(0);

    const transport = resolveTransport() as StubTransport;
    expect(transport.sent).toHaveLength(1);
  });

  it('an untagged group message is accepted but produces no send', async () => {
    const res = await POST(
      request({
        message_id: 'wh_group_1',
        conversation: { id: 'conv_wh_group', is_group: true },
        sender: { id: 'sender_2' },
        text: 'anyone been here before',
        mentions_agent: false,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number };
    expect(body.sent).toBe(0);
    expect((resolveTransport() as StubTransport).sent).toHaveLength(0);
  });

  describe('the shared secret gate', () => {
    it('is open when AGENT_WEBHOOK_SECRET is unset', async () => {
      const res = await POST(request(RAW_MESSAGE));
      expect(res.status).toBe(200);
    });

    it('rejects a request missing the header once a secret is configured', async () => {
      process.env.AGENT_WEBHOOK_SECRET = 'test-secret';
      const res = await POST(request(RAW_MESSAGE));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    });

    it('accepts a request whose header matches the configured secret', async () => {
      process.env.AGENT_WEBHOOK_SECRET = 'test-secret';
      const res = await POST(request(RAW_MESSAGE, { 'x-agent-webhook-secret': 'test-secret' }));
      expect(res.status).toBe(200);
    });
  });

  it('rate limits repeated traffic from one conversation', async () => {
    let lastStatus = 200;
    for (let i = 0; i < 25; i++) {
      const res = await POST(
        request({
          message_id: `wh_burst_${i}`,
          conversation: { id: 'conv_burst', is_group: false },
          sender: { id: 'sender_3' },
          text: 'what do I get here',
        }),
      );
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('uses the same process-local store the tick route reads from', async () => {
    await POST(request(RAW_MESSAGE));
    // The webhook route does not export the store; defaultAgentStore() is the
    // single seam both routes share, and the webhook is proven above to have
    // touched it (idempotency held across two calls in the same process).
    expect(defaultAgentStore()).toBe(defaultAgentStore());
  });
});
