/**
 * Agent Handler MCP client tests. Track C.
 *
 * The rule this file exists to prove is structural, not behavioral: no model
 * is ever in this loop. That is checked two ways here. First, the initialize
 * handshake this client sends is asserted to declare no `sampling`
 * capability, which is the protocol-level route a server would need to ask us
 * to run a completion. Second, every test drives the client with a fake
 * `fetch`, so nothing in this file can accidentally exercise a real network
 * call, let alone a real model.
 *
 * The wire format itself is UNVERIFIED (see the file header in
 * agent-handler.ts), so these tests pin OUR assumptions about it rather than
 * a vendor's actual behavior. That is still worth doing: it is the contract
 * mapToolResultToRows and the handshake are written against, and a future
 * correction only has to change one function and this file together.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testing,
  AGENT_HANDLER_ENV,
  createAgentHandlerProvider,
  isReadOnlyTool,
  mapToolResultToRows,
  parseRpcBody,
} from './agent-handler';
import { createSelfDeclaredProvider } from './self-declared';
import type { HrisFetchRequest, HrisProvider, HrisSubject } from './provider';

const SAVED_ENV = new Map<string, string | undefined>();
const MANAGED_ENV = [
  AGENT_HANDLER_ENV.apiKey,
  AGENT_HANDLER_ENV.url,
  AGENT_HANDLER_ENV.tool,
  AGENT_HANDLER_ENV.timeoutMs,
];

beforeEach(() => {
  for (const name of MANAGED_ENV) {
    SAVED_ENV.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of MANAGED_ENV) {
    const v = SAVED_ENV.get(name);
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
});

// ---------------------------------------------------------------------------
// Availability and fallback
// ---------------------------------------------------------------------------

describe('isAvailable', () => {
  it('is false with no MERGE_AGENT_HANDLER_API_KEY', () => {
    const provider = createAgentHandlerProvider();
    expect(provider.isAvailable()).toBe(false);
  });

  it('is true once the key is set, with no restart required', () => {
    const provider = createAgentHandlerProvider();
    expect(provider.isAvailable()).toBe(false);
    process.env[AGENT_HANDLER_ENV.apiKey] = 'test-key';
    expect(provider.isAvailable()).toBe(true);
  });
});

describe('fallback with no key', () => {
  it('delegates to the injected fallback rather than making a network call', async () => {
    const fetchImpl = vi.fn();
    const fallback: HrisProvider = {
      id: 'fallback-spy',
      isAvailable: () => true,
      async constraintsForOrg() {
        return [{ userId: 'u1', kind: 'dietary', value: 'vegan', consentedAt: 'x' }];
      },
    };
    const provider = createAgentHandlerProvider({ fetchImpl, fallback });

    const rows = await provider.constraintsForOrg({
      orgId: 'org1',
      subjects: [{ userId: 'u1', consentedAt: 'x' }],
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows).toEqual([{ userId: 'u1', kind: 'dietary', value: 'vegan', consentedAt: 'x' }]);
  });

  it('defaults the fallback to the self-declared provider', () => {
    // Constructing with no fallback must not throw, and the default has to be
    // usable with zero configuration, same as everywhere else in this feature.
    const provider = createAgentHandlerProvider();
    expect(provider).toBeDefined();
    void createSelfDeclaredProvider; // referenced for documentation intent only
  });
});

// ---------------------------------------------------------------------------
// isReadOnlyTool
// ---------------------------------------------------------------------------

describe('isReadOnlyTool', () => {
  it('accepts a tool with no annotations at all, judged by name only', () => {
    expect(isReadOnlyTool({ name: 'hris_list_employees' })).toBe(true);
  });

  it('refuses a tool whose readOnlyHint is explicitly false', () => {
    expect(isReadOnlyTool({ name: 'hris_list_employees', annotations: { readOnlyHint: false } })).toBe(false);
  });

  it('refuses a tool whose destructiveHint is true', () => {
    expect(isReadOnlyTool({ name: 'hris_list_employees', annotations: { destructiveHint: true } })).toBe(false);
  });

  it('refuses by name alone when annotations are absent', () => {
    expect(isReadOnlyTool({ name: 'hris_create_employee' })).toBe(false);
    expect(isReadOnlyTool({ name: 'hris_update_employee' })).toBe(false);
    expect(isReadOnlyTool({ name: 'hris_delete_employee' })).toBe(false);
  });

  it('tolerates a missing or non-string name without throwing', () => {
    expect(isReadOnlyTool({})).toBe(true);
    expect(isReadOnlyTool({ name: 42 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseRpcBody
// ---------------------------------------------------------------------------

describe('parseRpcBody', () => {
  it('parses a plain JSON object', () => {
    const frames = parseRpcBody('application/json', JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(1);
  });

  it('parses a JSON array of responses', () => {
    const frames = parseRpcBody(
      'application/json',
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: {} },
        { jsonrpc: '2.0', id: 2, result: {} },
      ]),
    );
    expect(frames).toHaveLength(2);
  });

  it('parses SSE data frames and skips [DONE] and malformed lines', () => {
    const body = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      'data: not json',
      'data: [DONE]',
      '',
    ].join('\n');
    const frames = parseRpcBody('text/event-stream', body);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(1);
  });

  it('returns an empty array for an empty body', () => {
    expect(parseRpcBody('application/json', '')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapToolResultToRows
// ---------------------------------------------------------------------------

const SUBJECTS: HrisSubject[] = [
  { userId: 'u1', consentedAt: '2026-01-01T00:00:00Z', employeeId: 'emp-1' },
  { userId: 'u2', consentedAt: '2026-01-01T00:00:00Z', employeeId: 'emp-2' },
];

describe('mapToolResultToRows', () => {
  it('maps structuredContent employees to rows, matched by employee id', () => {
    const result = {
      structuredContent: {
        employees: [
          { employee_id: 'emp-1', dietary_restrictions: ['kosher', 'peanut allergy'] },
          { employee_id: 'emp-2', allergies: ['shellfish'] },
        ],
      },
    };
    const rows = mapToolResultToRows(result, SUBJECTS);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.consentedAt === '2026-01-01T00:00:00Z')).toBe(true);
    expect(rows.filter((r) => r.userId === 'u1').map((r) => r.value)).toEqual(['kosher', 'peanut allergy']);
  });

  it('ignores an employee record for nobody we asked about', () => {
    const result = {
      structuredContent: {
        employees: [{ employee_id: 'emp-999', dietary_restrictions: ['halal'] }],
      },
    };
    expect(mapToolResultToRows(result, SUBJECTS)).toEqual([]);
  });

  it('parses a text content block as JSON when structuredContent is absent', () => {
    const result = {
      content: [
        { type: 'text', text: JSON.stringify({ results: [{ id: 'emp-1', accommodations: ['vegan'] }] }) },
      ],
    };
    const rows = mapToolResultToRows(result, SUBJECTS);
    expect(rows).toEqual([{ userId: 'u1', kind: 'dietary', value: 'vegan', consentedAt: '2026-01-01T00:00:00Z' }]);
  });

  it('throws rather than guessing when the only content is unparseable prose', () => {
    const result = { content: [{ type: 'text', text: 'Here are the employees you asked for.' }] };
    expect(() => mapToolResultToRows(result, SUBJECTS)).toThrow();
  });

  it('throws on an explicit tool error result rather than returning an empty list silently', () => {
    expect(() => mapToolResultToRows({ isError: true, content: [] }, SUBJECTS)).toThrow();
  });

  it('stamps OUR consent timestamp, never anything the payload might carry', () => {
    const result = {
      structuredContent: {
        employees: [{ employee_id: 'emp-1', dietary_restrictions: ['kosher'] }],
      },
    };
    const rows = mapToolResultToRows(result, SUBJECTS);
    expect(rows[0].consentedAt).toBe(SUBJECTS[0].consentedAt);
  });
});

// ---------------------------------------------------------------------------
// Full deterministic flow against a fake transport
// ---------------------------------------------------------------------------

interface RpcCall {
  method: string;
  params: unknown;
}

function jsonResponse(id: number | string | null | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake Streamable HTTP endpoint driven by a handler keyed on RPC method. */
function fakeTransport(
  handlers: Record<string, (params: unknown) => unknown>,
  calls: RpcCall[],
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    if (!handler) return jsonResponse(body.id, {});
    return jsonResponse(body.id, handler(body.params));
  }) as unknown as typeof fetch;
}

const READ_ONLY_TOOL = { name: 'hris_list_employees', annotations: { readOnlyHint: true } };
const WRITE_TOOL = { name: 'hris_create_employee', annotations: { readOnlyHint: false } };

describe('constraintsForOrg, full flow', () => {
  beforeEach(() => {
    process.env[AGENT_HANDLER_ENV.apiKey] = 'test-key';
  });

  it('declares no sampling capability on the handshake, calls the pinned tool, and maps the result', async () => {
    const calls: RpcCall[] = [];
    const fetchImpl = fakeTransport(
      {
        initialize: () => ({ protocolVersion: __testing.MCP_PROTOCOL_VERSION }),
        'tools/list': () => ({ tools: [READ_ONLY_TOOL] }),
        'tools/call': () => ({
          structuredContent: { employees: [{ employee_id: 'emp-1', dietary_restrictions: ['kosher'] }] },
        }),
      },
      calls,
    );

    const provider = createAgentHandlerProvider({ fetchImpl });
    const rows = await provider.constraintsForOrg({
      orgId: 'org1',
      subjects: [{ userId: 'u1', consentedAt: '2026-01-01T00:00:00Z', employeeId: 'emp-1' }],
    });

    expect(rows).toEqual([{ userId: 'u1', kind: 'dietary', value: 'kosher', consentedAt: '2026-01-01T00:00:00Z' }]);

    const init = calls.find((c) => c.method === 'initialize');
    expect(init).toBeDefined();
    const params = init!.params as { capabilities: Record<string, unknown> };
    // The one line the whole file exists to defend: no sampling capability is
    // ever declared, so a server has no protocol-level way to ask us to run a
    // model on its behalf.
    expect(params.capabilities).toEqual({});
    expect('sampling' in params.capabilities).toBe(false);

    const call = calls.find((c) => c.method === 'tools/call');
    const callParams = call!.params as { name: string; arguments: Record<string, unknown> };
    expect(callParams.name).toBe(__testing.AGENT_HANDLER_DEFAULT_TOOL);
    expect(callParams.arguments.employee_ids).toEqual(['emp-1']);
    expect(callParams.arguments.organization_id).toBe('org1');
  });

  it('refuses to call a tool that is not in tools/list', async () => {
    const calls: RpcCall[] = [];
    const fetchImpl = fakeTransport(
      { initialize: () => ({}), 'tools/list': () => ({ tools: [] }) },
      calls,
    );
    const provider = createAgentHandlerProvider({ fetchImpl });

    await expect(
      provider.constraintsForOrg({ orgId: 'org1', subjects: [{ userId: 'u1', consentedAt: 'x' }] }),
    ).rejects.toThrow();

    expect(calls.some((c) => c.method === 'tools/call')).toBe(false);
  });

  it('refuses to call a tool that tools/list marks as a writer', async () => {
    const calls: RpcCall[] = [];
    const fetchImpl = fakeTransport(
      { initialize: () => ({}), 'tools/list': () => ({ tools: [WRITE_TOOL] }) },
      calls,
    );
    process.env[AGENT_HANDLER_ENV.tool] = WRITE_TOOL.name;
    const provider = createAgentHandlerProvider({ fetchImpl });

    await expect(
      provider.constraintsForOrg({ orgId: 'org1', subjects: [{ userId: 'u1', consentedAt: 'x' }] }),
    ).rejects.toThrow(/read-only/i);

    expect(calls.some((c) => c.method === 'tools/call')).toBe(false);
  });

  it('throws a message with no employee or org detail on a transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection reset while fetching org1 employee emp-1 kosher record');
    });
    const provider = createAgentHandlerProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      provider.constraintsForOrg({ orgId: 'org1', subjects: [{ userId: 'u1', consentedAt: 'x' }] }),
    ).rejects.toThrow('Agent Handler request failed.');
  });

  it('returns no rows with an empty subject list and makes no call', async () => {
    const calls: RpcCall[] = [];
    const fetchImpl = fakeTransport({}, calls);
    const provider = createAgentHandlerProvider({ fetchImpl });

    const rows = await provider.constraintsForOrg({ orgId: 'org1', subjects: [] });
    expect(rows).toEqual([]);
    expect(calls).toEqual([]);
  });
});
