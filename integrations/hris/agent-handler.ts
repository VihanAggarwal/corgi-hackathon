/**
 * Merge Agent Handler, driven as a DETERMINISTIC MCP client. Track C.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * Agent Handler's documented happy path is to hand its MCP server to an AI
 * agent and let the agent decide which tools to call. We do not do that. HRIS
 * dietary and religious records are GDPR Article 9 special category data, and
 * that integration puts them in a model's context window on the first call.
 *
 * MCP is a client/server protocol with typed tool definitions. Nothing in it
 * requires an LLM to be the caller. An MCP client is ordinary code, so this
 * file is the client: it calls one named tool with arguments computed from our
 * own consent records, and no model is in the loop at any point. Hard rule 3
 * governs what reaches a prompt, not which vendor fetched the data. Fetching
 * Article 9 data over MCP is fine. Letting a model choose to fetch it, or see
 * it, is not. See docs/TRACK-C-MERGE-BRIEF.md.
 *
 * Two structural details carry that rule rather than a comment carrying it:
 *   - The initialize handshake declares NO `sampling` capability. Sampling is
 *     the MCP mechanism by which a server asks its client to run a model
 *     completion. A client that does not declare it cannot be asked, so the
 *     server has no protocol-level route to an LLM through us.
 *   - The tool is pinned by name and checked against tools/list before it is
 *     called. There is no discovery step whose output selects a tool, because
 *     "choose the right tool" is the decision we are refusing to delegate.
 *
 * READ ONLY, ENFORCED TWICE
 * Agent Handler is pitched around write actions. We want zero write capability
 * anywhere near this integration, so the configured tool must be present in
 * tools/list and must not advertise itself as destructive or as a writer. A
 * tool that fails that check is refused rather than called.
 *
 * ============================== UNVERIFIED ==============================
 * We do not have an Agent Handler account wired up, so the wire format below is
 * inferred from the MCP specification plus the shape of Merge's docs. Every
 * assumption is isolated in this file and every one of them is overridable by
 * an environment variable, so verification is a config change and not a
 * rewrite. What needs confirming, in the order it will bite:
 *
 *   1. ENDPOINT. AGENT_HANDLER_DEFAULT_URL is a guess. Override with
 *      MERGE_AGENT_HANDLER_URL.
 *   2. TRANSPORT. Assumed MCP Streamable HTTP: JSON-RPC 2.0 over POST, with the
 *      response either application/json or an SSE stream. If Merge exposes only
 *      the older HTTP+SSE transport, postRpc is the one function to change.
 *   3. AUTH. Assumed `Authorization: Bearer <api key>`, with the linked account
 *      token passed as `X-Account-Token`, which is the Merge REST convention.
 *   4. TOOL NAME. AGENT_HANDLER_DEFAULT_TOOL is a guess. Override with
 *      MERGE_AGENT_HANDLER_TOOL. Confirm which HRIS connectors are actually
 *      enabled on the account first; the brief names Workday as the likely one.
 *   5. TOOL ARGUMENTS. We send employee ids when we have them and fall back to
 *      an org-scoped fetch when we do not. Argument names are in TOOL_ARG_KEYS.
 *   6. RESULT SHAPE. Handled by mapToolResultToRows, which is written to accept
 *      several plausible layouts rather than to guess one confidently.
 *
 * None of this is invented certainty. If the connector is not there, the
 * registry never selects this provider and the self-declared path runs instead.
 * ========================================================================
 *
 * NOTHING HERE LOGS. Not the response, not a parse failure, not a caught error
 * body. Merge's own audit trail will record these tool calls, which is exactly
 * why consented_at is the gate that makes them defensible, but our side adds no
 * second copy.
 */

import type { ConstraintRow } from '../../lib/db';
import { createSelfDeclaredProvider } from './self-declared';
import type { HrisFetchRequest, HrisProvider, HrisSubject } from './provider';

export const AGENT_HANDLER_PROVIDER_ID = 'merge-agent-handler';

/** Env names in one place so the deploy checklist is greppable. */
export const AGENT_HANDLER_ENV = {
  apiKey: 'MERGE_AGENT_HANDLER_API_KEY',
  url: 'MERGE_AGENT_HANDLER_URL',
  tool: 'MERGE_AGENT_HANDLER_TOOL',
  timeoutMs: 'MERGE_AGENT_HANDLER_TIMEOUT_MS',
} as const;

/** UNVERIFIED. See the header. */
const AGENT_HANDLER_DEFAULT_URL = 'https://api.merge.dev/api/agent-handler/v1/mcp';

/** UNVERIFIED. See the header. */
const AGENT_HANDLER_DEFAULT_TOOL = 'hris_list_employees';

/**
 * MCP protocol revision we speak. Sent on initialize and echoed on later posts.
 * A server that negotiates a different revision is accepted: the three methods
 * we use have been stable across revisions, and refusing would turn a version
 * bump on Merge's side into an outage on ours.
 */
const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Conference wifi is assumed to fail at least once. Do not wait forever for it. */
const DEFAULT_TIMEOUT_MS = 8000;

/** A response larger than this is not an employee list, it is a problem. */
const MAX_RESPONSE_BYTES = 2_000_000;

/**
 * Argument names we send. Extracted so the tool contract lives in one literal
 * rather than being spelled inline at the call site.
 */
const TOOL_ARG_KEYS = {
  employeeIds: 'employee_ids',
  orgId: 'organization_id',
} as const;

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A live MCP session. Held for the duration of one fetch and then dropped: we
 * do not pool sessions, because a pooled session outliving a rotated key is a
 * failure that only shows up under load.
 */
interface Session {
  readonly endpoint: string;
  readonly headers: Record<string, string>;
  sessionId: string | null;
  nextId: number;
}

export interface AgentHandlerOptions {
  /** Injected for tests. Defaults to global fetch, resolved at call time. */
  fetchImpl?: typeof fetch;
  /**
   * Used when the api key is absent. Defaults to the self-declared provider,
   * which is the whole degradation story: no Merge credential means the
   * dinner still plans, from rows people entered about themselves.
   */
  fallback?: HrisProvider;
}

function env(name: string): string {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function timeoutMs(): number {
  const raw = Number(env(AGENT_HANDLER_ENV.timeoutMs));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Parse a Streamable HTTP body.
 *
 * The transport permits either a plain JSON object or an SSE stream carrying
 * one or more `data:` frames. Both are handled here rather than at the call
 * site, because which one arrives is a server choice we do not control.
 */
export function parseRpcBody(contentType: string, body: string): JsonRpcResponse[] {
  if (contentType.includes('text/event-stream')) {
    const out: JsonRpcResponse[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0 || payload === '[DONE]') continue;
      try {
        out.push(JSON.parse(payload) as JsonRpcResponse);
      } catch {
        // A malformed frame in a stream is not a reason to discard the frames
        // that parsed. The caller fails later if the id it wanted never arrived.
      }
    }
    return out;
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Generic by design: an error string from this path must not carry a row in it. */
function transportError(): Error {
  return new Error('Agent Handler request failed.');
}

async function readBounded(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw transportError();
  return text;
}

async function postRpc(
  session: Session,
  method: string,
  params: unknown,
  doFetch: typeof fetch,
): Promise<unknown> {
  const id = session.nextId++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());

  let response: Response;
  try {
    response = await doFetch(session.endpoint, {
      method: 'POST',
      headers: {
        ...session.headers,
        ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
    });
  } catch {
    throw transportError();
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw transportError();

  // The session id is issued on the initialize response and echoed afterwards.
  const issued = response.headers.get('mcp-session-id');
  if (issued) session.sessionId = issued;

  const contentType = response.headers.get('content-type') ?? '';
  let frames: JsonRpcResponse[];
  try {
    frames = parseRpcBody(contentType, await readBounded(response));
  } catch {
    throw transportError();
  }

  const match = frames.find((f) => f.id === id) ?? frames[0];
  if (!match) throw transportError();
  // The message is the server's, and a server that echoes an argument into its
  // error text would put an employee id in ours. Ours says nothing.
  if (match.error) throw transportError();
  return match.result;
}

/** Fire-and-forget notification. A server that rejects it is not fatal. */
async function notify(session: Session, method: string, doFetch: typeof fetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    await doFetch(session.endpoint, {
      method: 'POST',
      headers: {
        ...session.headers,
        ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      signal: controller.signal,
    });
  } catch {
    // The handshake notification is advisory. Swallowing it keeps a strict
    // server and a lenient one on the same code path.
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool safety
// ---------------------------------------------------------------------------

interface ToolDescriptor {
  name?: unknown;
  annotations?: {
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
    idempotentHint?: unknown;
  };
}

/**
 * Whether a tools/list entry is safe for us to call.
 *
 * Guarantees a refusal for anything that advertises a write. `readOnlyHint` is
 * a hint and an absent hint is not proof of anything, so absence is tolerated
 * and only a positive claim of destructiveness, or an explicit
 * `readOnlyHint: false`, is treated as disqualifying. The name check catches
 * the common case that the hints are simply not populated: a tool called
 * `hris_create_employee` is a writer whatever its annotations say.
 */
export function isReadOnlyTool(tool: ToolDescriptor): boolean {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === false) return false;
  if (a.destructiveHint === true) return false;

  const name = typeof tool.name === 'string' ? tool.name.toLowerCase() : '';
  const writeVerbs = [
    'create', 'update', 'delete', 'remove', 'write', 'set_', 'patch',
    'upsert', 'terminate', 'archive', 'send', 'post_', 'invite',
  ];
  return !writeVerbs.some((v) => name.includes(v));
}

function toolList(result: unknown): ToolDescriptor[] {
  const tools = (result as { tools?: unknown } | null)?.tools;
  return Array.isArray(tools) ? (tools as ToolDescriptor[]) : [];
}

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

/** Keys an employee record might carry its HRIS identifier under. UNVERIFIED. */
const EMPLOYEE_ID_KEYS = ['employee_id', 'employeeId', 'remote_id', 'remoteId', 'id'];

/** Keys an employee record might carry constraint values under. UNVERIFIED. */
const CONSTRAINT_LIST_KEYS = [
  'dietary_restrictions',
  'dietaryRestrictions',
  'dietary_preferences',
  'dietaryPreferences',
  'food_allergies',
  'foodAllergies',
  'allergies',
  'accommodations',
  'constraints',
];

/** Keys a wrapper object might carry the employee array under. UNVERIFIED. */
const COLLECTION_KEYS = ['employees', 'results', 'records', 'data', 'items'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The employee array, wherever this particular connector chose to put it. */
function findCollection(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of COLLECTION_KEYS) {
    const v = record[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** One constraint entry, however this connector spells it. */
function constraintValuesFrom(employee: Record<string, unknown>): Array<{ kind: string; value: string }> {
  const out: Array<{ kind: string; value: string }> = [];
  for (const key of CONSTRAINT_LIST_KEYS) {
    const raw = employee[key];
    const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    for (const entry of list) {
      if (typeof entry === 'string') {
        const value = entry.trim();
        if (value.length > 0) out.push({ kind: 'dietary', value });
        continue;
      }
      const record = asRecord(entry);
      if (!record) continue;
      const value = String(record.value ?? record.name ?? record.label ?? '').trim();
      if (value.length === 0) continue;
      out.push({ kind: String(record.kind ?? record.type ?? record.category ?? 'dietary'), value });
    }
  }
  return out;
}

/**
 * Turn a tools/call result into constraint rows.
 *
 * Guarantees: every returned row belongs to a subject that was asked about,
 * matched by HRIS employee id and never by name, email, or any other
 * near-identifier. An employee the response mentions who is not in `subjects`
 * produces nothing, so a connector returning the whole company cannot widen the
 * set. consentedAt is copied from OUR membership record, never from the vendor.
 *
 * Exported because it is the single place the unverified response shape lives,
 * and it is the piece most likely to need a one-line correction once the real
 * wire format is in hand.
 */
export function mapToolResultToRows(
  result: unknown,
  subjects: readonly HrisSubject[],
): ConstraintRow[] {
  const record = asRecord(result);
  if (record?.isError === true) throw transportError();

  const byEmployeeId = new Map<string, HrisSubject>();
  for (const s of subjects) {
    if (typeof s.employeeId === 'string' && s.employeeId.length > 0) {
      byEmployeeId.set(s.employeeId, s);
    }
  }

  // structuredContent when the server provides it, otherwise the first text
  // block parsed as JSON. Text is the universally supported shape; structured
  // output is the newer one and is preferred when present.
  let payload: unknown = record?.structuredContent;
  if (payload === undefined) {
    const content = Array.isArray(record?.content) ? (record!.content as unknown[]) : [];
    const textBlock = content
      .map((b) => asRecord(b))
      .find((b) => b !== null && b.type === 'text' && typeof b.text === 'string');
    if (!textBlock) return [];
    try {
      payload = JSON.parse(String(textBlock.text));
    } catch {
      // A tool that answered in prose is a tool we cannot use deterministically.
      // Returning nothing is wrong in the safe direction only if the caller
      // treats an empty set as suspicious, so it throws instead.
      throw transportError();
    }
  }

  const rows: ConstraintRow[] = [];
  for (const entry of findCollection(payload)) {
    const employee = asRecord(entry);
    if (!employee) continue;

    let subject: HrisSubject | undefined;
    for (const key of EMPLOYEE_ID_KEYS) {
      const id = employee[key];
      if (typeof id === 'string' || typeof id === 'number') {
        subject = byEmployeeId.get(String(id));
        if (subject) break;
      }
    }
    if (!subject) continue;

    for (const c of constraintValuesFrom(employee)) {
      rows.push({
        userId: subject.userId,
        kind: c.kind,
        value: c.value,
        consentedAt: subject.consentedAt,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * Build the Agent Handler provider.
 *
 * Guarantees:
 *  - Never reads the environment at import time. isAvailable() is evaluated per
 *    call, so a missing key can never throw during module evaluation and a key
 *    that appears later starts working without a restart.
 *  - isAvailable() is false without MERGE_AGENT_HANDLER_API_KEY, so the
 *    registry selects the self-declared provider instead. Calling this provider
 *    directly with no key delegates to the same fallback rather than failing.
 *  - No model is invoked at any point. The MCP handshake declares no sampling
 *    capability, and the tool is pinned by name rather than chosen.
 *  - The tool is verified present and read-only via tools/list before it is
 *    called. No write capability is requested anywhere.
 *  - Returns rows only for subjects in the request, stamped with our consent
 *    timestamps.
 *  - Throws a message-free error on any transport, protocol, or parse failure,
 *    and logs nothing at all.
 */
export function createAgentHandlerProvider(options: AgentHandlerOptions = {}): HrisProvider {
  const fallback = options.fallback ?? createSelfDeclaredProvider();

  return {
    id: AGENT_HANDLER_PROVIDER_ID,

    isAvailable(): boolean {
      return env(AGENT_HANDLER_ENV.apiKey).length > 0;
    },

    async constraintsForOrg(request: HrisFetchRequest): Promise<readonly ConstraintRow[]> {
      const apiKey = env(AGENT_HANDLER_ENV.apiKey);
      if (apiKey.length === 0) return fallback.constraintsForOrg(request);
      if (request.subjects.length === 0) return [];

      const doFetch = options.fetchImpl ?? globalThis.fetch;
      if (typeof doFetch !== 'function') throw transportError();

      const session: Session = {
        endpoint: env(AGENT_HANDLER_ENV.url) || AGENT_HANDLER_DEFAULT_URL,
        headers: {
          'content-type': 'application/json',
          // Both are required by the Streamable HTTP transport: the server
          // picks which one it answers with.
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${apiKey}`,
          'mcp-protocol-version': MCP_PROTOCOL_VERSION,
          ...(request.accountToken ? { 'x-account-token': request.accountToken } : {}),
        },
        sessionId: null,
        nextId: 1,
      };

      // 1. Handshake. capabilities is deliberately empty. Declaring `sampling`
      //    here is what would let the server ask us to run a model completion,
      //    and refusing that capability is the protocol-level form of "no model
      //    is in this loop".
      await postRpc(
        session,
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'tastetwins-deterministic-hris-client', version: '1' },
        },
        doFetch,
      );
      await notify(session, 'notifications/initialized', doFetch);

      // 2. Verify the one tool we intend to call. This is a check, not a
      //    selection: the name comes from configuration, never from the list.
      const toolName = env(AGENT_HANDLER_ENV.tool) || AGENT_HANDLER_DEFAULT_TOOL;
      const listed = toolList(await postRpc(session, 'tools/list', {}, doFetch));
      const descriptor = listed.find((t) => t.name === toolName);
      if (!descriptor) throw new Error('Agent Handler HRIS tool is not available.');
      if (!isReadOnlyTool(descriptor)) {
        throw new Error('Agent Handler HRIS tool is not read-only. Refusing to call it.');
      }

      // 3. Call it with ids we computed from our own consent records.
      const employeeIds = request.subjects
        .map((s) => s.employeeId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      const args: Record<string, unknown> = { [TOOL_ARG_KEYS.orgId]: request.orgId };
      if (employeeIds.length > 0) args[TOOL_ARG_KEYS.employeeIds] = employeeIds;

      const result = await postRpc(
        session,
        'tools/call',
        { name: toolName, arguments: args },
        doFetch,
      );

      return mapToolResultToRows(result, request.subjects);
    },
  };
}

/** Internals reachable from the test file only. Not part of the module surface. */
export const __testing = {
  AGENT_HANDLER_DEFAULT_TOOL,
  AGENT_HANDLER_DEFAULT_URL,
  MCP_PROTOCOL_VERSION,
  TOOL_ARG_KEYS,
};
