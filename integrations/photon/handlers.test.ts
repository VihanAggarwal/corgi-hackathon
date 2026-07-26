/**
 * Photon handler tests. Track C.
 *
 * Four things this suite has to prove, because the Track C prompt calls them
 * out by name:
 *   1. the follow-up parser turns varied freeform replies into ratings
 *   2. a reply produces a theta change AND a consequence sentence that
 *      reflects the REAL delta, not a template
 *   3. an untagged group message produces no response
 *   4. the transport interface can be swapped without touching handlers
 */

import { describe, expect, it } from 'vitest';
import { AXIS_COUNT, AXIS_KEYS } from '../../contracts/axes';
import type { Vec24 } from '../../contracts/types';
import { fitTheta } from '../../core';
import type { MenuOrderResult } from '../../integrations/vision';
import {
  buildFollowUpMessage,
  createInMemoryAgentStore,
  evaluateGroupGate,
  FOLLOW_UP_DELAY_MS,
  GROUP_JOIN_ANNOUNCEMENT,
  handleInboundMessage,
  conversationDeviceId,
  parseFollowUpReply,
  scheduleFollowUp,
  sendDueFollowUps,
  __testing,
  type AgentStore,
  type HandlerDeps,
} from './handlers';
import {
  createStubTransport,
  type InboundMessage,
  type OutboundMessage,
  type SendReceipt,
  type Transport,
} from './transport';

function zeros(): Vec24 {
  return new Array(AXIS_COUNT).fill(0);
}

function axisIdx(key: string): number {
  return AXIS_KEYS.indexOf(key as (typeof AXIS_KEYS)[number]);
}

const RICHNESS = axisIdx('fat_richness');

function inboundText(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: overrides.messageId ?? 'msg_1',
    conversation: overrides.conversation ?? { id: 'conv_1', isGroup: false },
    senderId: overrides.senderId ?? 'user_1',
    text: overrides.text ?? '',
    attachments: overrides.attachments ?? [],
    mentionsAgent: overrides.mentionsAgent ?? true,
    receivedAt: overrides.receivedAt ?? new Date().toISOString(),
  };
}

function deps(transport: Transport, store: AgentStore, extra: Partial<HandlerDeps> = {}): HandlerDeps {
  return { transport, store, ...extra };
}

// ---------------------------------------------------------------------------
// 1. The follow-up parser
// ---------------------------------------------------------------------------

describe('parseFollowUpReply', () => {
  const cases: Array<[string, number | null]> = [
    // A BARE NUMBER IS OUT OF TEN, because that is what the follow-up asks
    // for. Someone answering "8" to "how was it out of 10" does not mean 8 on
    // a five point scale. Stored on the frozen 1-5 schema via tenToFive.
    ['10', 5],
    ['9', 5],
    ['8', 4],
    ['7', 4],
    ['6', 3],
    ['5', 3],
    ['3', 2],
    ['2', 1],
    ['1', 1],
    ['8/10', 4],
    ['2/10', 1],
    ['10/10', 5],
    ['7 out of 10', 4],
    // An explicit /5 is still honored: the person overrode the frame.
    ['4/5', 4],
    ['5/5', 5],
    ['5 stars', 5],
    ['4 out of 5', 4],
    ['it was amazing', 5],
    ['loved it', 5],
    ['incredible, best thing I have had in months', 5],
    ['pretty good', 4],
    ['good, would get again', 4],
    ['it was fine', 3],
    ['fine I guess', 3],
    ['okay, nothing special', 3],
    ['mixed feelings honestly', 3],
    ['not that good', 2],
    ["wasn't great", 2],
    ["didn't really like it", 2],
    ['kind of bad', 2],
    ['underwhelming', 2],
    ['not really my thing', 2],
    ['terrible', 1],
    ['hated it', 1],
    ['awful, would not order again', 1],
    ['worst dish on the menu', 1],
    ['not bad at all', 4],
    ['', null],
    ['   ', null],
    ['thanks for asking', null],
    ['what time do you close', null],
  ];

  it.each(cases)('parses %j as %j', (text, expected) => {
    expect(parseFollowUpReply(text)).toBe(expected);
  });

  it('checks patterns in a fixed order so idioms beat the bare word they contain', () => {
    // "not bad" contains "bad", which alone means hated (1). The idiom rule
    // has to be checked first or this reads backwards.
    expect(parseFollowUpReply('not bad')).toBe(4);
    // "wasn't great" contains "great", which alone means liked (4).
    expect(parseFollowUpReply('honestly wasn’t great')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Theta actually changes, and the sentence reflects the real delta
// ---------------------------------------------------------------------------

describe('the follow-up reply moves theta and the reply reflects the real delta', () => {
  it('a disliked rating pulls theta down on the dish dominant axis, and the reply names that axis', () => {
    const dishPhi = zeros();
    dishPhi[RICHNESS] = 3;
    const thetaAtSend = zeros();
    thetaAtSend[RICHNESS] = 0.6;

    // Compute the expected outcome independently, the same way the handler
    // does internally, so the assertion is checked against real math and not
    // a copy of the implementation's constants.
    const expectedFit = fitTheta([{ winnerPhi: zeros(), loserPhi: dishPhi }], {
      prior: thetaAtSend,
      lambda: 4,
    });
    const expectedDelta = expectedFit.theta[RICHNESS] - thetaAtSend[RICHNESS];
    expect(expectedDelta).toBeLessThan(0);

    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    let refitTheta: Vec24 | null = null;

    scheduleFollowUp(
      store,
      { conversationId: 'conv_r', dishName: 'the short rib', venueName: null, dishPhi, theta: thetaAtSend, nComparisons: 12 },
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    store.markFollowUpSent('conv_r', '2026-01-01T00:00:00.000Z');

    return handleInboundMessage(
      inboundText({ conversation: { id: 'conv_r', isGroup: false }, text: 'honestly it was pretty bad' }),
      deps(transport, store, {
        onThetaRefit: (_conversationId, fit) => {
          refitTheta = fit.theta;
        },
      }),
    ).then((outbound) => {
      expect(outbound).toHaveLength(1);
      const text = outbound[0].text;

      // The axis named is the one that actually moved, in axis-label language,
      // not the raw key.
      expect(text.toLowerCase()).toContain('richness');
      expect(text.toLowerCase()).toContain('down');

      // Theta really moved, and moved the same direction the independent
      // computation predicts.
      expect(refitTheta).not.toBeNull();
      const actualDelta = (refitTheta as unknown as Vec24)[RICHNESS] - thetaAtSend[RICHNESS];
      expect(actualDelta).toBeLessThan(0);
      expect(actualDelta).toBeCloseTo(expectedDelta, 6);

      // The follow-up is resolved and a log exists, so a retry cannot double count it.
      expect(store.activeFollowUp('conv_r')).toBeNull();
      expect(store.dishLogs('conv_r')).toHaveLength(1);
      expect(store.dishLogs('conv_r')[0].rating).toBe(2);
    });
  });

  it('a different dish and a different rating produce a different consequence sentence, not a fixed template', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const saltyPhi = zeros();
    const SALT = axisIdx('salt');
    saltyPhi[SALT] = 3;
    const thetaAtSend = zeros();
    thetaAtSend[SALT] = 0.6;

    scheduleFollowUp(
      store,
      { conversationId: 'conv_s', dishName: 'the pickled greens', venueName: null, dishPhi: saltyPhi, theta: thetaAtSend, nComparisons: 12 },
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    store.markFollowUpSent('conv_s', '2026-01-01T00:00:00.000Z');

    const outbound = await handleInboundMessage(
      inboundText({ conversation: { id: 'conv_s', isGroup: false }, text: 'loved it, so good' }),
      deps(transport, store),
    );

    const text = outbound[0].text;
    expect(text.toLowerCase()).toContain('salt level');
    expect(text.toLowerCase()).toContain('up');
    // Different from the richness/down case above: the two sentences are not
    // interchangeable copies of one template.
    expect(text.toLowerCase()).not.toContain('richness');
  });

  it('a rating of 3 writes a log but never calls fitTheta and never claims an axis moved', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    const dishPhi = zeros();
    dishPhi[RICHNESS] = 3;
    const thetaAtSend = zeros();
    thetaAtSend[RICHNESS] = 0.6;

    scheduleFollowUp(
      store,
      { conversationId: 'conv_n', dishName: 'the salad', venueName: null, dishPhi, theta: thetaAtSend, nComparisons: 12 },
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    store.markFollowUpSent('conv_n', '2026-01-01T00:00:00.000Z');

    let refitCalled = false;
    const outbound = await handleInboundMessage(
      inboundText({ conversation: { id: 'conv_n', isGroup: false }, text: 'it was fine' }),
      deps(transport, store, { onThetaRefit: () => { refitCalled = true; } }),
    );

    expect(refitCalled).toBe(false);
    expect(outbound[0].text.toLowerCase()).toContain('down the middle');
    expect(store.dishLogs('conv_n')[0].rating).toBe(3);
  });

  it('an unparseable reply asks a plain clarifying question and leaves the follow-up open', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    const dishPhi = zeros();
    dishPhi[RICHNESS] = 3;

    scheduleFollowUp(
      store,
      { conversationId: 'conv_u', dishName: 'the dumplings', venueName: null, dishPhi, theta: zeros(), nComparisons: 12 },
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    store.markFollowUpSent('conv_u', '2026-01-01T00:00:00.000Z');

    const outbound = await handleInboundMessage(
      inboundText({ conversation: { id: 'conv_u', isGroup: false }, text: 'what time do you close' }),
      deps(transport, store),
    );

    expect(outbound[0].text).toMatch(/cant tell/i);
    // Still active: a garbled reply must not silently close out the follow-up.
    expect(store.activeFollowUp('conv_u')).not.toBeNull();
  });
});

describe('countWatchlistFlips and dominantAxis (pure helpers)', () => {
  it('counts only the items that actually cross the zero line in the stated direction', () => {
    const oldTheta = zeros();
    oldTheta[RICHNESS] = 1;
    const newTheta = zeros();
    newTheta[RICHNESS] = -1;

    const above = zeros();
    above[RICHNESS] = 1; // dot: 1 before, -1 after -> flips down
    const alreadyBelow = zeros();
    alreadyBelow[RICHNESS] = -1; // dot: -1 before, 1 after -> does not count for 'down'
    const untouched = zeros(); // dot: 0 before and after -> never counts

    const flips = __testing.countWatchlistFlips(
      oldTheta,
      newTheta,
      [{ name: 'a', phi: above }, { name: 'b', phi: alreadyBelow }, { name: 'c', phi: untouched }],
      'down',
    );
    expect(flips).toBe(1);
  });

  it('reports null when nothing moved past the noise floor', () => {
    const theta = zeros();
    expect(__testing.dominantAxis(theta, theta)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scheduling and the tick that sends the check-in
// ---------------------------------------------------------------------------

describe('scheduleFollowUp and sendDueFollowUps', () => {
  it('is due exactly at FOLLOW_UP_DELAY_MS and not a moment before', () => {
    const store = createInMemoryAgentStore();
    const start = new Date('2026-01-01T00:00:00.000Z');
    scheduleFollowUp(
      store,
      { conversationId: 'conv_t', dishName: 'the ramen', venueName: null, dishPhi: zeros(), theta: zeros(), nComparisons: 0 },
      () => start,
    );

    const justBefore = new Date(start.getTime() + FOLLOW_UP_DELAY_MS - 1);
    expect(store.dueFollowUps(justBefore)).toHaveLength(0);

    const atDue = new Date(start.getTime() + FOLLOW_UP_DELAY_MS);
    expect(store.dueFollowUps(atDue)).toHaveLength(1);
  });

  it('sends the check-in through the transport and marks it sent so a second tick is a no-op', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    const start = new Date('2026-01-01T00:00:00.000Z');
    scheduleFollowUp(
      store,
      { conversationId: 'conv_v', dishName: 'paneer tikka', venueName: null, dishPhi: zeros(), theta: zeros(), nComparisons: 0 },
      () => start,
    );

    const due = new Date(start.getTime() + FOLLOW_UP_DELAY_MS + 1000);
    const sentFirst = await sendDueFollowUps(store, transport, () => due);
    expect(sentFirst).toHaveLength(1);
    expect(sentFirst[0].text).toBe('hows the paneer tikka? out of 10');
    expect(sentFirst[0].kind).toBe('follow_up');
    expect(transport.sent).toHaveLength(1);

    const sentSecond = await sendDueFollowUps(store, transport, () => due);
    expect(sentSecond).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);
  });

  it('buildFollowUpMessage never carries a recipient, only a conversation (hard rule 4)', () => {
    const store = createInMemoryAgentStore();
    const pending = scheduleFollowUp(
      store,
      { conversationId: 'conv_w', dishName: 'the tacos', venueName: null, dishPhi: zeros(), theta: zeros(), nComparisons: 0 },
    );
    const msg = buildFollowUpMessage(pending);
    expect(Object.keys(msg).sort()).toEqual(['conversationId', 'kind', 'text'].sort());
  });
});

// ---------------------------------------------------------------------------
// 3. Group gating: untagged traffic produces no response
// ---------------------------------------------------------------------------

describe('group threads', () => {
  it('an untagged group message produces no response and is not processed', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const outbound = await handleInboundMessage(
      inboundText({
        conversation: { id: 'group_1', isGroup: true },
        mentionsAgent: false,
        text: 'what is everyone getting',
      }),
      deps(transport, store),
    );

    expect(outbound).toEqual([]);
    expect(transport.sent).toEqual([]);
    // Never greeted, because an untagged message is not a join event either.
    expect(store.hasGreetedGroup('group_1')).toBe(false);
  });

  it('the first tagged message in a group gets the join announcement, said once', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const first = await handleInboundMessage(
      inboundText({ conversation: { id: 'group_2', isGroup: true }, mentionsAgent: true, text: '@agent what do I get here' }),
      deps(transport, store),
    );
    expect(first[0].text).toBe(GROUP_JOIN_ANNOUNCEMENT);
    expect(first).toHaveLength(2); // announcement + the actual reply

    const second = await handleInboundMessage(
      inboundText({ messageId: 'msg_2', conversation: { id: 'group_2', isGroup: true }, mentionsAgent: true, text: '@agent under $20' }),
      deps(transport, store),
    );
    expect(second.some((m) => m.text === GROUP_JOIN_ANNOUNCEMENT)).toBe(false);
  });

  it('evaluateGroupGate never returns shouldRespond for an untagged group message', () => {
    const store = createInMemoryAgentStore();
    const gate = evaluateGroupGate(
      inboundText({ conversation: { id: 'group_3', isGroup: true }, mentionsAgent: false }),
      store,
    );
    expect(gate.shouldRespond).toBe(false);
    expect(gate.announcement).toBeNull();
  });

  it('a direct (non-group) message never gets the group announcement', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    const outbound = await handleInboundMessage(
      inboundText({ conversation: { id: 'dm_1', isGroup: false }, text: 'what do I get here' }),
      deps(transport, store),
    );
    expect(outbound.some((m) => m.text === GROUP_JOIN_ANNOUNCEMENT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('webhook retries', () => {
  it('replaying the same messageId is a no-op', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    const message = inboundText({ messageId: 'dupe_1', text: 'what do I get here' });

    const first = await handleInboundMessage(message, deps(transport, store));
    const second = await handleInboundMessage(message, deps(transport, store));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Inbound photo delegates to the menu flow, never reimplements it
// ---------------------------------------------------------------------------

describe('inbound photo', () => {
  it('delegates to the injected menu flow and relays its picks verbatim', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    transport.setAttachmentBytes('att_0', new Uint8Array([1, 2, 3, 4]));

    let calledWith: unknown = null;
    const outbound = await handleInboundMessage(
      inboundText({
        text: '',
        attachments: [{ id: 'att_0', mimeType: 'image/jpeg', url: null }],
      }),
      deps(transport, store, {
        orderFromMenuPhoto: async (input) => {
          calledWith = input;
          return {
            status: 'ok',
            preface: null,
            picks: [{ dishName: 'liang pi', priceCents: 1200, text: 'Get the liang pi.', packetId: 'pkt_1', confidence: 'high' }],
            read: { itemsSeen: 4, itemsReadable: 4, unreadableLineCount: 0, stub: false },
            constraintsAppliedCount: 0,
          };
        },
      }),
    );

    expect(calledWith).not.toBeNull();
    expect(outbound[0].text).toBe('Get the liang pi.');
  });

  it('schedules a follow-up when the menu flow hands back a phi vector, and does not when it does not', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    transport.setAttachmentBytes('att_0', new Uint8Array([1, 2, 3, 4]));

    const phi = zeros();
    phi[RICHNESS] = 2;
    // Not a MenuPick today (see the Track C report on the contract gap), built
    // here as the shape a small additive field would take and threaded through
    // via an unsafe cast at the seam only a test is allowed to use.
    const pickWithPhi = {
      dishName: 'the short rib',
      priceCents: 3200,
      text: 'Get the short rib.',
      packetId: 'pkt_2',
      confidence: 'high' as const,
      phi,
    };

    await handleInboundMessage(
      inboundText({ conversation: { id: 'photo_1', isGroup: false }, attachments: [{ id: 'att_0', mimeType: 'image/jpeg', url: null }] }),
      deps(transport, store, {
        orderFromMenuPhoto: async () => ({
          status: 'ok',
          preface: null,
          picks: [pickWithPhi] as unknown as MenuOrderResult['picks'],
          read: { itemsSeen: 1, itemsReadable: 1, unreadableLineCount: 0, stub: false },
          constraintsAppliedCount: 0,
        }),
      }),
    );

    const due = new Date(Date.now() + FOLLOW_UP_DELAY_MS + 1000);
    expect(store.dueFollowUps(due)).toHaveLength(1);
  });

  it('does not schedule a follow-up when the pipeline result carries no phi (the current, real menu flow)', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    transport.setAttachmentBytes('att_0', new Uint8Array([1, 2, 3, 4]));

    await handleInboundMessage(
      inboundText({ conversation: { id: 'photo_2', isGroup: false }, attachments: [{ id: 'att_0', mimeType: 'image/jpeg', url: null }] }),
      deps(transport, store, {
        orderFromMenuPhoto: async () => ({
          status: 'ok',
          preface: null,
          picks: [{ dishName: 'the short rib', priceCents: 3200, text: 'Get the short rib.', packetId: 'pkt_3', confidence: 'high' }],
          read: { itemsSeen: 1, itemsReadable: 1, unreadableLineCount: 0, stub: false },
          constraintsAppliedCount: 0,
        }),
      }),
    );

    const due = new Date(Date.now() + FOLLOW_UP_DELAY_MS + 1000);
    expect(store.dueFollowUps(due)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

describe('plain text queries', () => {
  /** A person who has calibrated, so the agent may answer rather than onboard. */
  const calibrated = (transport: Transport, store: ReturnType<typeof createInMemoryAgentStore>) => ({
    ...deps(transport, store),
    getUserState: async () => ({ theta: new Array(24).fill(0), nComparisons: 40 }),
  });

  it('never fabricates a recommendation: it points back to a surface that can produce one', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const overview = await handleInboundMessage(
      inboundText({ text: 'what do I get here' }),
      calibrated(transport, store),
    );
    expect(overview[0].text).toMatch(/photo/i);

    const priced = await handleInboundMessage(
      inboundText({ messageId: 'msg_p', text: 'find me lunch under $20' }),
      calibrated(transport, store),
    );
    expect(priced[0].text).toContain('$20');
    expect(priced[0].text).toMatch(/photo/i);
  });

  // -------------------------------------------------------------------------
  // Onboarding: a cold text becomes a calibration link, not a guess.
  // -------------------------------------------------------------------------

  it('asks for the area first, and does not file the cold message as one', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const first = await handleInboundMessage(
      inboundText({ text: 'hey' }),
      deps(transport, store),
    );

    expect(first[0].text).toMatch(/what area are you in/i);
    expect(first[0].text).not.toContain('/duel');
    // The regression this guards: "hey" is a plausible looking neighborhood to
    // a permissive matcher, and must not be recorded as one.
    expect(store.area('conv_1')).toBeNull();
  });

  it('sends the link once it has an area, carrying the conversation id', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    await handleInboundMessage(inboundText({ text: 'hey' }), deps(transport, store));
    const out = await handleInboundMessage(
      inboundText({ messageId: 'msg_area', text: 'lower east side' }),
      deps(transport, store),
    );

    expect(store.area('conv_1')).toBe('lower east side');
    expect(out[0].text).toContain('/duel');
    // Without d= the browser invents a random id and the swipes are orphaned.
    expect(out[0].text).toMatch(/[?&]d=/);
    expect(out[0].text).toMatch(/lower east side/i);
    expect(out[0].text).not.toMatch(/photo/i);
  });

  it('still onboards a partially calibrated person, and says why', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    store.setArea('conv_1', 'astoria');

    const out = await handleInboundMessage(inboundText({ text: 'hey' }), {
      ...deps(transport, store),
      getUserState: async () => ({ theta: new Array(24).fill(0), nComparisons: 4 }),
    });

    expect(out[0].text).toContain('/duel');
    // Different copy from the cold case: it acknowledges the duels already played.
    expect(out[0].text).toMatch(/rough read/i);
  });

  it('has a calibration floor the corpus can actually reach', async () => {
    // The floor sat at 12 while selectDuels, which never repeats a dish, could
    // only produce 10 duels from a 20 dish corpus. Anyone who swiped the whole
    // feed was still told to go calibrate, forever. This asserts the two agree.
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();
    store.setArea('conv_1', 'chinatown');

    const maxDuelsCorpusCanProduce = Math.floor(20 / 2);
    const out = await handleInboundMessage(inboundText({ text: 'where should i eat' }), {
      ...deps(transport, store),
      getUserState: async () => ({
        theta: new Array(24).fill(0),
        nComparisons: maxDuelsCorpusCanProduce,
      }),
      recommendForConversation: async () => [{ text: 'get the liang pi at Hunan Slurp.' }],
    });

    expect(out[0].text).toContain('liang pi');
    expect(out[0].text).not.toContain('/duel');
  });

  it('gives the same device id for a conversation every time, or profiles fork', () => {
    const a = conversationDeviceId('iMessage;-;+15551234567');
    const b = conversationDeviceId('iMessage;-;+15551234567');
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{4,64}$/);
  });

  // -------------------------------------------------------------------------
  // The reported bug: a calibrated person asking where to eat was told to send
  // a menu photo, even though the corpus recommendation needs no menu at all.
  // -------------------------------------------------------------------------

  it('recommends from the corpus instead of asking for a menu photo', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const out = await handleInboundMessage(inboundText({ text: 'what do I get here' }), {
      ...calibrated(transport, store),
      recommendForConversation: async () => [
        { text: 'get the liang pi at Hunan Slurp, about $14. it comes out cold, which throws people.' },
      ],
    });

    expect(out[0].text).toContain('liang pi');
    expect(out[0].text).not.toMatch(/photo/i);
    // The ask is what makes the review loop exist at all.
    expect(out[0].text).toMatch(/out of 10/i);
  });

  it('falls back honestly when the corpus returns nothing, and never invents a pick', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const out = await handleInboundMessage(inboundText({ text: 'where should i eat' }), {
      ...calibrated(transport, store),
      recommendForConversation: async () => [],
    });

    expect(out[0].text).toMatch(/stand behind/i);
    expect(out[0].text).not.toMatch(/out of 10/i);
  });

  it('survives a recommender that throws rather than pushing an error to a phone', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const out = await handleInboundMessage(inboundText({ text: 'where should i eat' }), {
      ...calibrated(transport, store),
      recommendForConversation: async () => {
        throw new Error('renderer exploded');
      },
    });

    expect(out).toHaveLength(1);
    expect(out[0].text).not.toMatch(/exploded|error|stack/i);
  });

  it('writes like a text message, not a review', async () => {
    const store = createInMemoryAgentStore();
    const transport = createStubTransport();

    const out = await handleInboundMessage(
      inboundText({ text: 'what do I get here' }),
      calibrated(transport, store),
    );
    const text = out[0].text;

    // Hard rule 6 survives the register change: informal is not excited.
    expect(text).not.toMatch(/[!]/);
    expect(text).not.toMatch(/\bI\b/); // lowercase "i" only
    expect(text[0]).toBe(text[0].toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// 4. The transport can be swapped without touching handlers
// ---------------------------------------------------------------------------

describe('transport independence', () => {
  it('handleInboundMessage works identically against any object satisfying Transport, not just the stub', async () => {
    const store = createInMemoryAgentStore();
    const sent: OutboundMessage[] = [];

    // A second, independent Transport implementation. If handlers.ts secretly
    // depended on StubTransport's extra fields, this would fail to compile or
    // to run.
    const fakeTransport: Transport = {
      name: 'fake',
      async send(message) {
        sent.push(message);
        const receipt: SendReceipt = { id: 'fake_1', conversationId: message.conversationId, sentAt: new Date().toISOString() };
        return receipt;
      },
      receive(raw) {
        return raw as InboundMessage;
      },
      async attach() {
        return null;
      },
    };

    const outbound = await handleInboundMessage(
      inboundText({ text: 'what do I get here' }),
      deps(fakeTransport, store),
    );

    expect(outbound).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(outbound[0].text);
  });
});
