/**
 * Photon Spectrum runner. Track C.
 *
 *   npx tsx integrations/photon/spectrum-runner.ts
 *
 * The live bridge between Photon's Spectrum SDK and our handlers. This is a
 * LONG-RUNNING PROCESS on the presenter's laptop, deliberately not a Vercel
 * route: spectrum.messages is an async iterator that holds a connection open,
 * which is exactly the shape serverless kills. The web surfaces stay on
 * Vercel; the agent runs here. If this process dies mid-demo, the web cards
 * still work and nothing structural is lost.
 *
 * WHAT WAS VERIFIED VS ASSUMED (Photon's API was unverified until today)
 * Verified against spectrum-ts 12.4.0's shipped types:
 *   - Spectrum({ projectId, projectSecret, providers }) -> instance
 *   - instance.messages yields [space, message] pairs
 *   - space.send(string) sends text; ContentInput = string | ContentBuilder
 *   - Message: { id, content, sender, space, timestamp, direction }
 *   - iMessage DMs THROW on space.getMembers() ("remote + group only")
 * Still assumed, flagged inline: the exact Content union member names for
 * attachments. Extraction is written tolerantly against .type discriminants
 * rather than trusting one spelling.
 *
 * HARD RULE 4 HOLDS HERE THE SAME WAY IT HOLDS EVERYWHERE
 * The transport below can only send into a space it has already received a
 * message from. There is no lookup from a person to a space, no way to
 * address a user, and the registry key is the conversation id the message
 * arrived on. The runner cannot express "deliver this to person B".
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { Spectrum } from 'spectrum-ts';
// The subpath, not the 'spectrum-ts/providers' barrel: the barrel re-exports
// every platform, and @photon-ai/slack ships a package.json whose exports map
// resolves to nothing under Node's CJS loader, so importing the barrel crashes
// at startup for a provider we never use.
import { imessage } from 'spectrum-ts/providers/imessage';
import {
  agentHandle,
  textTagsAgent,
  type AttachmentBytes,
  type InboundAttachment,
  type InboundMessage,
  type OutboundMessage,
  type SendReceipt,
  type Transport,
} from './transport';
import { defaultAgentStore, handleInboundMessage, sendDueFollowUps } from './handlers';

// Minimal structural views of the SDK objects we touch. Typed locally rather
// than importing the SDK's 6,000-line union so a minor SDK bump cannot break
// the runner over a type we never read.
interface SpectrumSpace {
  readonly id: string;
  send(content: string): Promise<unknown>;
  getMembers(): Promise<unknown[]>;
}
interface SpectrumMessage {
  readonly id: string;
  content: unknown;
  sender: { id?: string } | undefined;
  timestamp: Date;
  direction: 'inbound' | 'outbound';
}

const FOLLOW_UP_TICK_MS = 30_000;

// ---------------------------------------------------------------------------
// Content extraction, tolerant on purpose
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Pull the human-readable text out of a Content union member.
 *
 * Content is a zod discriminated union on .type. 'text' carries the message
 * body; other members (reactions, renames, typing) carry none and correctly
 * produce an empty string, which the handlers treat as nothing to answer.
 */
function contentText(content: unknown): string {
  const rec = asRecord(content);
  if (!rec) return typeof content === 'string' ? content : '';
  if (typeof rec.text === 'string') return rec.text;
  if (typeof rec.body === 'string') return rec.body;
  return '';
}

/**
 * Pull attachments out of Content. The attachment member's exact field names
 * are the one part of the SDK surface not confirmed from types, so every read
 * is optional and a shape we do not recognize contributes nothing rather than
 * throwing mid-demo.
 */
function contentAttachments(content: unknown): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  const visit = (node: unknown, index: number): void => {
    const rec = asRecord(node);
    if (!rec) return;
    if (rec.type === 'attachment') {
      out.push({
        id: typeof rec.id === 'string' ? rec.id : `att-${index}`,
        mimeType:
          typeof rec.mimeType === 'string'
            ? rec.mimeType
            : typeof rec.contentType === 'string'
              ? rec.contentType
              : null,
        url: typeof rec.url === 'string' ? rec.url : null,
        bytes: rec.data instanceof Uint8Array ? rec.data : undefined,
      });
    }
    // Some content shapes nest a list (multi-attachment sends).
    for (const key of ['attachments', 'items', 'contents']) {
      const list = rec[key];
      if (Array.isArray(list)) list.forEach((child, i) => visit(child, i));
    }
  };
  visit(content, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Group detection
// ---------------------------------------------------------------------------

/**
 * Whether a space is a group chat.
 *
 * The SDK exposes no flag; its own docs say iMessage DMs THROW on
 * getMembers ("remote + group only"). So the throw IS the signal: members
 * resolve means group, UnsupportedError means DM. Cached per space id because
 * the answer cannot change for iMessage and the probe is a network call.
 */
const groupCache = new Map<string, boolean>();

async function isGroupSpace(space: SpectrumSpace): Promise<boolean> {
  const cached = groupCache.get(space.id);
  if (cached !== undefined) return cached;
  let result: boolean;
  try {
    const members = await space.getMembers();
    result = Array.isArray(members) && members.length > 1;
  } catch {
    result = false;
  }
  groupCache.set(space.id, result);
  return result;
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * Transport backed by live Spectrum spaces.
 *
 * The registry is populated exclusively by the receive loop, so the only
 * addresses this transport knows are conversations the agent was already
 * spoken to in. That is hard rule 4 as a data-flow property.
 */
class SpectrumTransport implements Transport {
  readonly name = 'spectrum';
  private readonly spaces = new Map<string, SpectrumSpace>();

  register(space: SpectrumSpace): void {
    this.spaces.set(space.id, space);
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const space = this.spaces.get(message.conversationId);
    if (!space) {
      // A follow-up for a conversation from a previous process run. The store
      // will retry on the next tick once the person messages again; sending
      // blind is impossible by construction, which is the point.
      throw new Error(`No live space for conversation ${message.conversationId}.`);
    }
    await space.send(message.text);
    return {
      id: `sp-${Date.now().toString(36)}`,
      conversationId: message.conversationId,
      sentAt: new Date().toISOString(),
    };
  }

  receive(raw: unknown): InboundMessage | null {
    // The runner normalizes typed [space, message] pairs directly in the loop;
    // raw webhook payloads are the webhook route's job, not this transport's.
    void raw;
    return null;
  }

  async attach(ref: InboundAttachment): Promise<AttachmentBytes | null> {
    if (ref.bytes) return { id: ref.id, mimeType: ref.mimeType, bytes: ref.bytes };
    if (!ref.url) return null;
    try {
      const res = await fetch(ref.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      return {
        id: ref.id,
        mimeType: ref.mimeType ?? res.headers.get('content-type'),
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function normalize(
  space: SpectrumSpace,
  message: SpectrumMessage,
): Promise<InboundMessage> {
  const text = contentText(message.content);
  const group = await isGroupSpace(space);
  return {
    messageId: message.id,
    conversation: { id: space.id, isGroup: group },
    senderId: message.sender?.id ?? 'unknown',
    text,
    attachments: contentAttachments(message.content),
    // In a DM every message is addressed to the agent. In a group, only an
    // explicit tag counts; handlers ignore everything else entirely.
    mentionsAgent: group ? textTagsAgent(text) : true,
    receivedAt:
      message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const projectId =
    process.env.SPECTRUM_PROJECT_ID ?? process.env.PHOTON_PROJECT_ID ?? '';
  const projectSecret =
    process.env.SPECTRUM_PROJECT_SECRET ?? process.env.PHOTON_PROJECT_SECRET ?? '';

  if (!projectId || !projectSecret) {
    console.error(
      'Missing SPECTRUM_PROJECT_ID or SPECTRUM_PROJECT_SECRET in .env.local.',
    );
    process.exit(1);
  }

  console.log(`\nspectrum runner starting as @${agentHandle()}`);

  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });

  const transport = new SpectrumTransport();
  const store = defaultAgentStore();

  // Follow-ups fire on a timer because nothing in the message loop wakes
  // itself up two hours later. Failures inside a tick are already survived
  // per-conversation by sendDueFollowUps.
  const ticker = setInterval(() => {
    void sendDueFollowUps(store, transport).catch(() => {});
  }, FOLLOW_UP_TICK_MS);
  ticker.unref?.();

  console.log('connected. waiting for messages.\n');

  for await (const [space, message] of app.messages as AsyncIterable<
    [SpectrumSpace, SpectrumMessage]
  >) {
    try {
      if (message.direction === 'outbound') continue;
      transport.register(space);
      const inbound = await normalize(space, message);
      const preview = inbound.text.slice(0, 60).replace(/\s+/g, ' ');
      console.log(
        `[${inbound.conversation.isGroup ? 'group' : 'dm'}] ${inbound.messageId}: ${preview}`,
      );
      const replies = await handleInboundMessage(inbound, { transport, store });
      for (const r of replies) console.log(`  -> ${r.text.slice(0, 80)}`);
    } catch (err) {
      // One bad message must never take the agent down mid-demo.
      console.error(`message failed: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
