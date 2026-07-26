/**
 * Photon transport. Track C.
 *
 * PHOTON'S WIRE FORMAT IS UNVERIFIED, AND THIS FILE IS WHERE THAT UNCERTAINTY
 * IS QUARANTINED. Everything above it, handlers.ts and the webhook route, is
 * written against the Transport interface and knows nothing about Photon at
 * all. If the vendor turns out to speak a different shape, or does not work,
 * one file changes and the agent falls back to Track B's web cards with nothing
 * structural lost. That is the entire reason this seam exists.
 *
 * THREE METHODS, AND NO FOURTH
 *   send     one outbound message into one conversation
 *   receive  one provider payload normalized into one InboundMessage
 *   attach   the bytes behind one inbound attachment
 *
 * HARD RULE 4 IS ENFORCED BY THE TYPE, NOT BY CARE
 * OutboundMessage has a conversationId and no recipient, no sender, no
 * forwardedFrom, and no participants list. There is no shape in this file that
 * can express "deliver what person A said to person B", so no amount of clever
 * handler code can build one. The agent talks to one person at a time because
 * the only address it can write down is the conversation a request arrived in.
 *
 * NO CREDENTIALS TODAY
 * resolveTransport() returns the in-memory stub unless PHOTON_API_KEY and an
 * explicit send URL are both present, checked at call time. Nothing here throws
 * at import time for a missing variable, and no endpoint path is guessed: the
 * HTTP transport sends exactly where its configuration tells it to.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Where a turn is happening.
 *
 * `isGroup` is the only structural fact handlers need, because the group rules
 * are about whether the agent may speak at all, not about who else is present.
 * The participant list is deliberately absent: handlers that cannot see the
 * other members cannot address one of them.
 */
export interface Conversation {
  id: string;
  isGroup: boolean;
}

export interface InboundAttachment {
  id: string;
  /** Provider-reported mime type. A hint, since the provider shape is unverified. */
  mimeType: string | null;
  /** Where the bytes live, when the payload carries a reference rather than data. */
  url: string | null;
  /** Inline bytes, when the payload carries them directly. */
  bytes?: Uint8Array;
}

export interface InboundMessage {
  /**
   * Provider message id. Webhooks retry, so this is what makes a repeated
   * delivery a no-op rather than a second recommendation and a second log.
   */
  messageId: string;
  conversation: Conversation;
  /**
   * Opaque provider id of the one human this turn is with. Never used as an
   * address for anyone else.
   */
  senderId: string;
  text: string;
  attachments: InboundAttachment[];
  /**
   * True only when the agent was explicitly tagged. In a group, false means the
   * agent did not hear it: see handlers.ts, which does not read untagged group
   * traffic at all.
   */
  mentionsAgent: boolean;
  receivedAt: string;
}

/**
 * One message out.
 *
 * There is no recipient field and there will not be one. See the file header:
 * the absence is the enforcement of hard rule 4.
 */
export interface OutboundMessage {
  conversationId: string;
  text: string;
  /** The inbound message this answers, when it answers one. Carried for tracing. */
  inReplyTo?: string;
  /** 'follow_up' is the only message the agent sends without being spoken to first. */
  kind: 'reply' | 'follow_up';
}

export interface SendReceipt {
  /** Provider id when the provider returns one, otherwise a locally generated id. */
  id: string;
  conversationId: string;
  sentAt: string;
}

export interface AttachmentBytes {
  id: string;
  mimeType: string | null;
  bytes: Uint8Array;
}

export interface Transport {
  /** Short name for logs and the health route. Never a credential. */
  readonly name: string;
  send(message: OutboundMessage): Promise<SendReceipt>;
  /** Normalize a raw provider payload. Returns null when it cannot be understood. */
  receive(raw: unknown): InboundMessage | null;
  /** Bytes behind an attachment, or null when they cannot be fetched. */
  attach(ref: InboundAttachment): Promise<AttachmentBytes | null>;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * The handle that counts as tagging the agent.
 *
 * Read at call time from PHOTON_AGENT_HANDLE so a deployment can rename the
 * agent without a code change, and defaulted so the demo works with no
 * environment at all.
 */
export function agentHandle(): string {
  const configured = (process.env.PHOTON_AGENT_HANDLE ?? '').trim();
  return configured.length > 0 ? configured.replace(/^@/, '') : 'tastetwins';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First present string among several candidate key spellings. */
function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function pickBoolean(source: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'boolean') return v;
  }
  return null;
}

function pickArray(source: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const v = source[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * Whether the agent's handle appears as a tag in the text.
 *
 * Word-boundary matched with an optional leading @, because "tastetwins" inside
 * a URL is not a tag and neither is it inside a longer word. A group message
 * that merely mentions the product is not an instruction to the agent.
 */
export function textTagsAgent(text: string, handle: string = agentHandle()): boolean {
  if (!text) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@/])@?${escaped}\\b`, 'i').test(text);
}

function normalizeAttachment(raw: unknown, index: number): InboundAttachment | null {
  if (typeof raw === 'string') {
    return { id: `att_${index}`, mimeType: null, url: raw };
  }
  const rec = asRecord(raw);
  if (!rec) return null;
  const url = pickString(rec, ['url', 'href', 'link', 'media_url', 'mediaUrl', 'download_url']);
  const id = pickString(rec, ['id', 'attachment_id', 'attachmentId', 'media_id']) ?? `att_${index}`;
  const mimeType = pickString(rec, ['mime_type', 'mimeType', 'content_type', 'contentType', 'type']);

  // Inline data, base64 or an already-decoded array. Accepted because a webhook
  // that carries the bytes is one fewer credentialed fetch on the demo path.
  let bytes: Uint8Array | undefined;
  const inline = rec.data ?? rec.bytes ?? rec.base64;
  if (typeof inline === 'string' && inline.length > 0) {
    try {
      bytes = decodeBase64(inline);
    } catch {
      bytes = undefined;
    }
  } else if (inline instanceof Uint8Array) {
    bytes = inline;
  }

  if (!url && !bytes) return null;
  return { id, mimeType, url: url ?? null, bytes };
}

/** Base64 without assuming Buffer, since a route handler may run on an edge runtime. */
function decodeBase64(input: string): Uint8Array {
  const cleaned = input.replace(/^data:[^;]*;base64,/, '');
  if (typeof atob === 'function') {
    const binary = atob(cleaned);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Node without atob. Buffer is a Uint8Array, so this needs no copy.
  return new Uint8Array(Buffer.from(cleaned, 'base64'));
}

/**
 * Turn a raw webhook body into an InboundMessage, or null.
 *
 * Guarantees: never throws on malformed input, never invents a conversation id
 * or a sender, and returns null rather than a half-populated message when the
 * payload does not carry the three things a turn cannot happen without (a
 * message id, a conversation, and a sender). Several key spellings are accepted
 * per field because the vendor's shape is unverified and being wrong about a
 * key name should not be the reason the demo fails.
 *
 * mentionsAgent is true when the payload says so OR when the handle is tagged
 * in the text. Direct messages are treated as tagged by definition: a message
 * sent to the agent alone is addressed to it.
 */
export function normalizeInbound(raw: unknown, handle: string = agentHandle()): InboundMessage | null {
  const root = asRecord(raw);
  if (!root) return null;

  // Providers commonly wrap the interesting object one level down.
  const body =
    asRecord(root.message) ?? asRecord(root.data) ?? asRecord(root.event) ?? asRecord(root.payload) ?? root;

  const messageId = pickString(body, ['message_id', 'messageId', 'id', 'sid', 'event_id']);
  if (!messageId) return null;

  const conversationRecord =
    asRecord(body.conversation) ?? asRecord(body.thread) ?? asRecord(body.chat) ?? asRecord(body.channel);
  const conversationId =
    (conversationRecord ? pickString(conversationRecord, ['id', 'conversation_id', 'thread_id']) : null) ??
    pickString(body, ['conversation_id', 'conversationId', 'thread_id', 'threadId', 'chat_id', 'channel_id']);
  if (!conversationId) return null;

  const senderRecord = asRecord(body.sender) ?? asRecord(body.from) ?? asRecord(body.author) ?? asRecord(body.user);
  const senderId =
    (senderRecord ? pickString(senderRecord, ['id', 'user_id', 'handle', 'phone', 'address']) : null) ??
    pickString(body, ['sender_id', 'senderId', 'from', 'user_id', 'author_id']);
  if (!senderId) return null;

  const text = pickString(body, ['text', 'body', 'content', 'message_text', 'caption']) ?? '';

  const attachments: InboundAttachment[] = [];
  const rawAttachments = [
    ...pickArray(body, ['attachments', 'media', 'files', 'images']),
    ...(conversationRecord ? [] : []),
  ];
  rawAttachments.forEach((a, i) => {
    const normalized = normalizeAttachment(a, i);
    if (normalized) attachments.push(normalized);
  });

  const isGroup =
    (conversationRecord ? pickBoolean(conversationRecord, ['is_group', 'isGroup', 'group']) : null) ??
    pickBoolean(body, ['is_group', 'isGroup', 'group']) ??
    // A conversation type of "group" is the other common spelling. Anything we
    // cannot read is treated as a direct message, which is the reading that
    // makes the agent MORE talkative, so it is checked again in handlers.ts
    // against mentionsAgent before a single word is sent.
    (conversationRecord ? pickString(conversationRecord, ['type', 'kind']) : null) === 'group';

  const flaggedMention =
    pickBoolean(body, ['mentions_agent', 'mentionsAgent', 'mentioned', 'is_mention']) ?? null;
  const mentionList = pickArray(body, ['mentions', 'mentioned_handles']).map((m) => {
    if (typeof m === 'string') return m.replace(/^@/, '').toLowerCase();
    const rec = asRecord(m);
    const name = rec ? pickString(rec, ['handle', 'name', 'id', 'username']) : null;
    return (name ?? '').replace(/^@/, '').toLowerCase();
  });

  const mentionsAgent =
    !isGroup ||
    flaggedMention === true ||
    mentionList.includes(handle.toLowerCase()) ||
    textTagsAgent(text, handle);

  const receivedAt =
    pickString(body, ['received_at', 'receivedAt', 'timestamp', 'created_at', 'sent_at']) ??
    new Date().toISOString();

  return {
    messageId,
    conversation: { id: conversationId, isGroup },
    senderId,
    text,
    attachments,
    mentionsAgent,
    receivedAt,
  };
}

/**
 * Whether an attachment is plausibly a photo.
 *
 * Permissive on purpose. A provider that reports no mime type, or reports
 * something we do not recognize, still gets handed to the menu flow, because
 * the menu flow can decline an unreadable image and a dropped photo is a dead
 * end for the user with no explanation.
 */
export function isLikelyImage(attachment: InboundAttachment): boolean {
  const mime = (attachment.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  if (mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('application/')) return false;
  if (attachment.url && /\.(png|jpe?g|heic|heif|webp|gif)(\?|$)/i.test(attachment.url)) return true;
  return mime.length === 0;
}

// ---------------------------------------------------------------------------
// Stub transport
// ---------------------------------------------------------------------------

export interface StubTransport extends Transport {
  /** Every outbound message, in order. The demo and the tests read this. */
  readonly sent: OutboundMessage[];
  readonly receipts: SendReceipt[];
  /** Bytes handed back by attach(), keyed by attachment id, for a fixture photo. */
  setAttachmentBytes(id: string, bytes: Uint8Array): void;
  reset(): void;
}

export interface StubTransportOptions {
  /** Injected clock, so a test can assert timing without waiting two hours. */
  now?: () => Date;
  handle?: string;
  /** Make send() reject, to exercise the delivery-failure path. */
  failSend?: boolean;
}

/** FNV-1a, matching the corpus pipeline so stub bytes are stable across machines. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * An in-memory transport that records what would have been sent.
 *
 * Guarantees: no network, no credentials, deterministic ids and attachment
 * bytes, and a complete ordered record of outbound messages. This is the
 * transport the whole product runs on until Photon is verified, so it is not a
 * test double bolted on the side: it is the default implementation, and the
 * demo path.
 */
export function createStubTransport(options: StubTransportOptions = {}): StubTransport {
  const now = options.now ?? ((): Date => new Date());
  const handle = options.handle ?? agentHandle();
  const sent: OutboundMessage[] = [];
  const receipts: SendReceipt[] = [];
  const bytesById = new Map<string, Uint8Array>();
  let counter = 0;

  return {
    name: 'stub',
    sent,
    receipts,

    async send(message: OutboundMessage): Promise<SendReceipt> {
      if (options.failSend) throw new Error('Stub transport is configured to fail sends.');
      counter += 1;
      const receipt: SendReceipt = {
        id: `stub_${counter}_${hash(message.conversationId + message.text).toString(36)}`,
        conversationId: message.conversationId,
        sentAt: now().toISOString(),
      };
      sent.push(message);
      receipts.push(receipt);
      return receipt;
    },

    receive(raw: unknown): InboundMessage | null {
      return normalizeInbound(raw, handle);
    },

    async attach(ref: InboundAttachment): Promise<AttachmentBytes | null> {
      const stored = ref.bytes ?? bytesById.get(ref.id);
      if (stored) return { id: ref.id, mimeType: ref.mimeType, bytes: stored };
      // Deterministic filler so a photo path can be exercised end to end with
      // no fixture file. The menu flow decides whether it can read it.
      const seed = hash(ref.id);
      const bytes = new Uint8Array(16);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (seed >>> (i % 4) * 8) & 0xff;
      return { id: ref.id, mimeType: ref.mimeType, bytes };
    },

    setAttachmentBytes(id: string, bytes: Uint8Array): void {
      bytesById.set(id, bytes);
    },

    reset(): void {
      sent.length = 0;
      receipts.length = 0;
      bytesById.clear();
      counter = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

export interface HttpTransportConfig {
  /** Absolute URL messages are POSTed to. Supplied by configuration, never guessed. */
  sendUrl: string;
  apiKey: string;
  /** Header the key travels in. Vendors disagree, so this is configuration. */
  authHeader?: string;
  /** Prefix for the key value, for example "Bearer ". Empty by default. */
  authScheme?: string;
  handle?: string;
  timeoutMs?: number;
}

/**
 * A transport that POSTs JSON to a configured URL.
 *
 * WHAT THIS IS NOT: a claim about Photon's API. Every route, header and field
 * name is supplied by configuration or is our own neutral spelling, because
 * inventing an endpoint would produce code that looks integrated and is not.
 * When the real shape is confirmed, this is the one function that changes.
 *
 * Guarantees: no network call at construction, a bounded timeout on every
 * request, and a thrown Error carrying the status but never the response body,
 * since a provider error body can echo the message text back into a log.
 */
export function createHttpTransport(config: HttpTransportConfig): Transport {
  const handle = config.handle ?? agentHandle();
  const authHeader = config.authHeader ?? 'Authorization';
  const authScheme = config.authScheme ?? '';
  const timeoutMs = config.timeoutMs ?? 10_000;

  return {
    name: 'http',

    async send(message: OutboundMessage): Promise<SendReceipt> {
      const res = await fetch(config.sendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [authHeader]: `${authScheme}${config.apiKey}`,
        },
        body: JSON.stringify({
          conversation_id: message.conversationId,
          text: message.text,
          in_reply_to: message.inReplyTo ?? null,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) throw new Error(`Photon send failed with status ${res.status}.`);

      let id = '';
      try {
        const parsed: unknown = await res.json();
        const rec = asRecord(parsed);
        id = (rec ? pickString(rec, ['id', 'message_id', 'messageId']) : null) ?? '';
      } catch {
        // A provider that returns no body is not a failure to send.
        id = '';
      }

      return {
        id: id.length > 0 ? id : `sent_${hash(message.conversationId + message.text).toString(36)}`,
        conversationId: message.conversationId,
        sentAt: new Date().toISOString(),
      };
    },

    receive(raw: unknown): InboundMessage | null {
      return normalizeInbound(raw, handle);
    },

    async attach(ref: InboundAttachment): Promise<AttachmentBytes | null> {
      if (ref.bytes) return { id: ref.id, mimeType: ref.mimeType, bytes: ref.bytes };
      if (!ref.url) return null;
      try {
        const res = await fetch(ref.url, {
          headers: { [authHeader]: `${authScheme}${config.apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        return {
          id: ref.id,
          mimeType: res.headers.get('content-type') ?? ref.mimeType,
          bytes: new Uint8Array(buf),
        };
      } catch {
        // A photo we cannot fetch is a photo the menu flow never sees. The user
        // gets told, which is better than a silent empty recommendation.
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Whether a live Photon transport can be built right now. Checked at call time. */
export function hasPhotonCredentials(): boolean {
  return Boolean((process.env.PHOTON_API_KEY ?? '').trim() && (process.env.PHOTON_SEND_URL ?? '').trim());
}

let cached: { signature: string; transport: Transport } | null = null;

/**
 * The transport the app should use.
 *
 * Guarantees: returns the stub whenever a live transport cannot be built, never
 * throws for a missing variable, and switches to HTTP with no code change the
 * moment PHOTON_API_KEY and PHOTON_SEND_URL both exist. The instance is cached
 * per environment signature so the stub's recorded messages survive across
 * requests in one process, which is what makes the demo readable.
 */
export function resolveTransport(): Transport {
  const key = (process.env.PHOTON_API_KEY ?? '').trim();
  const url = (process.env.PHOTON_SEND_URL ?? '').trim();
  const signature = `${url}#${key.length}#${agentHandle()}`;
  if (cached && cached.signature === signature) return cached.transport;

  const transport = hasPhotonCredentials()
    ? createHttpTransport({
        sendUrl: url,
        apiKey: key,
        authHeader: process.env.PHOTON_AUTH_HEADER || undefined,
        authScheme: process.env.PHOTON_AUTH_SCHEME || undefined,
      })
    : createStubTransport();

  cached = { signature, transport };
  return transport;
}

/** Drop the cached transport. For tests that mutate the environment. */
export function resetTransport(): void {
  cached = null;
}
