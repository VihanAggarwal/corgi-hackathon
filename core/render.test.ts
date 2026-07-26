/**
 * Renderer tests. Track A.
 *
 * The validator is the part of the renderer that has to be right, because it is
 * the only thing standing between a model's improvisation and a user reading a
 * fabricated recommendation. So most of this file is adversarial: known bad
 * outputs that a real model actually produces, each of which must be caught.
 *
 * Every test here runs with no ANTHROPIC_API_KEY.
 */

import { describe, expect, it } from 'vitest';
import { CONSTANTS, type EvidencePacket } from '../contracts/types';
import {
  RenderValidationError,
  buildPacketBrief,
  dryRunRender,
  renderRecommendation,
  splitSentences,
  twinChannelAllowed,
  validateRendering,
  type GenerateRequest,
  type ViolationCode,
} from './render';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The packet behind the target voice line, straight out of the build spec. */
function twinPacket(over: Partial<EvidencePacket> = {}): EvidencePacket {
  return {
    userAxes: [
      { axis: 'sweetness_savory', label: 'sweetness in savory food', value: -2.1, percentile: 4 },
    ],
    dish: {
      name: 'liang pi',
      venueName: 'Hunan Slurp',
      neighborhood: 'Lower East Side',
      priceCents: 1400,
      phiConfidence: 'high',
    },
    twinSupport: {
      n: 6,
      lift: 0.34,
      kFloorMet: true,
      clusterDescriptor: 'people who, like you, will not accept sweetness in savory food',
    },
    populationBaseline: { topDishName: 'noodles', topDishShare: 0.61 },
    caveats: [{ source: 'twin_note', n: 2, claim: 'served cold, unexpected' }],
    sourceChannel: 'twin',
    confidence: 'medium',
    constraintsAppliedCount: 2,
    ...over,
  };
}

/** Same dish, no twin channel. The strictest case: no group of people may exist. */
function soloPacket(over: Partial<EvidencePacket> = {}): EvidencePacket {
  const p = twinPacket(over);
  delete p.twinSupport;
  return p;
}

const TARGET_VOICE =
  "Hunan Slurp, get the liang pi. Six people who share your thing about sweetness in " +
  'savory food picked it over the noodles, which is not what the room does here, the ' +
  "room orders noodles. Two of them said it's colder than they expected, so probably " +
  "not tonight if you're cold.";

/** A clean, rule-abiding line for the solo packet, used as the base for injections. */
const SOLO_BASE =
  'Hunan Slurp, get the liang pi. It sits at the low end of sweetness in savory food, ' +
  'which is not what the room does here, the room orders noodles. It arrives cold, ' +
  'which surprises most people, so skip it if you want something hot.';

function codes(text: string, packet: EvidencePacket): ViolationCode[] {
  return validateRendering(text, packet).violations.map((v) => v.code);
}

// ---------------------------------------------------------------------------
// The target voice is the specification
// ---------------------------------------------------------------------------

describe('the target voice', () => {
  it('passes validation with no violations at all', () => {
    const result = validateRendering(TARGET_VOICE, twinPacket());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is three sentences, which is inside the limit', () => {
    expect(splitSentences(TARGET_VOICE)).toHaveLength(3);
  });

  it('base solo copy passes when there is no twin support', () => {
    expect(validateRendering(SOLO_BASE, soloPacket()).violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hard rule 6: enthusiasm
// ---------------------------------------------------------------------------

describe('enthusiasm markers', () => {
  const cases: Array<[string, string]> = [
    ['exclamation point', 'Hunan Slurp, get the liang pi! It arrives cold, so skip it if you want something hot.'],
    ['emoji', 'Hunan Slurp, get the liang pi 🔥. It arrives cold, so skip it if you want something hot.'],
    ["you'll love", "Hunan Slurp, get the liang pi. You'll love it, though it arrives cold."],
    ['amazing', 'Hunan Slurp, get the liang pi. It is amazing, though it arrives cold.'],
    ['must-try', 'Hunan Slurp, get the liang pi. It is a must-try, though it arrives cold.'],
    ['must try', 'Hunan Slurp, get the liang pi. It is a must try, though it arrives cold.'],
    ['incredible', 'Hunan Slurp, get the liang pi. It is incredible, though it arrives cold.'],
    ['delicious', 'Hunan Slurp, get the liang pi. It is delicious, though it arrives cold.'],
    ['hidden gem', 'Hunan Slurp, get the liang pi. It is a hidden gem, though it arrives cold.'],
    ['highly recommend', 'Hunan Slurp, get the liang pi. I highly recommend it, though it arrives cold.'],
    ['to die for', 'Hunan Slurp, get the liang pi. It is to die for, though it arrives cold.'],
    ['trust me', 'Hunan Slurp, get the liang pi. Trust me on it, though it arrives cold.'],
  ];

  for (const [name, text] of cases) {
    it(`catches ${name}`, () => {
      expect(codes(text, soloPacket())).toContain('enthusiasm');
    });
  }

  it('does not fire on flat copy that merely mentions a strong flavor', () => {
    const text =
      'Hunan Slurp, get the liang pi. The chili oil is heavy and the noodles the room ' +
      'orders are not, so skip it if you want something plain. It arrives cold.';
    expect(codes(text, soloPacket())).not.toContain('enthusiasm');
  });

  it('catches enthusiasm in an otherwise perfect line', () => {
    const good = validateRendering(SOLO_BASE, soloPacket());
    const bad = validateRendering(SOLO_BASE.replace('get the liang pi', 'get the delicious liang pi'), soloPacket());
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hard rule 2: nothing that is not in the packet
// ---------------------------------------------------------------------------

describe('ungrounded names', () => {
  it('catches a venue the packet never mentioned', () => {
    const text =
      'Hunan Slurp, get the liang pi. It is better than the version at Mission Chinese, ' +
      'though it arrives cold.';
    expect(codes(text, soloPacket())).toContain('ungrounded_name');
  });

  it('catches a lowercase dish name the packet never mentioned', () => {
    const text =
      'Hunan Slurp, get the dan dan noodles. It arrives cold, so skip it if you want ' +
      'something hot.';
    expect(codes(text, soloPacket())).toContain('ungrounded_name');
  });

  it('is not fooled by an invented dish that contains a packet word', () => {
    // "noodles" is in the packet as what the room orders. "cold sesame noodles" is not.
    const text =
      'Hunan Slurp, get the cold sesame noodles. It arrives cold, so skip it if you ' +
      'want something hot.';
    expect(codes(text, soloPacket())).toContain('ungrounded_name');
  });

  it('allows the dish, the venue, the neighborhood, and what the room orders', () => {
    const text =
      'Hunan Slurp, get the liang pi. It is the one thing on the Lower East Side worth ' +
      'crossing for, and it is not the noodles the room orders. It arrives cold.';
    expect(codes(text, soloPacket())).not.toContain('ungrounded_name');
  });

  it('does not treat "skip the wait" as a dish', () => {
    const text =
      'Hunan Slurp, get the liang pi. Go at four and skip the wait, since it arrives ' +
      'cold anyway.';
    expect(codes(text, soloPacket())).not.toContain('ungrounded_name');
  });
});

// ---------------------------------------------------------------------------
// Hard rule 5: no twin channel without support
// ---------------------------------------------------------------------------

describe('twin language without twin support', () => {
  const paraphrases: Array<[string, string]> = [
    ['the literal word', 'Hunan Slurp, get the liang pi. Your taste twins order it cold.'],
    ['people like you', 'Hunan Slurp, get the liang pi. People like you order it, and it arrives cold.'],
    ['others who share', 'Hunan Slurp, get the liang pi. Others who share your palate order it cold.'],
    ['a numbered group', 'Hunan Slurp, get the liang pi. Six people who eat like you picked it, and it arrives cold.'],
    ['of them said', 'Hunan Slurp, get the liang pi. Two of them said it arrives colder than expected.'],
    ['similar palate', 'Hunan Slurp, get the liang pi. Diners with a similar palate order it cold.'],
    ['who share', 'Hunan Slurp, get the liang pi. The people who share your thing about sweetness order it cold.'],
    ['everyone who', 'Hunan Slurp, get the liang pi. Everyone who eats the way you do orders it cold.'],
  ];

  for (const [name, text] of paraphrases) {
    it(`catches ${name}`, () => {
      expect(codes(text, soloPacket())).toContain('twin_without_support');
    });
  }

  it('allows the same sentence once the packet actually has twin support', () => {
    const text =
      'Hunan Slurp, get the liang pi. Six people who share your thing about sweetness in ' +
      'savory food picked it, and it arrives cold.';
    expect(codes(text, twinPacket())).not.toContain('twin_without_support');
  });

  it('still forbids twin language when the k floor is not met', () => {
    const belowFloor = twinPacket({
      twinSupport: {
        n: CONSTANTS.K_FLOOR - 1,
        lift: 0.4,
        kFloorMet: false,
        clusterDescriptor: 'people who avoid sweetness in savory food',
      },
    });
    expect(twinChannelAllowed(belowFloor)).toBe(false);
    const text =
      'Hunan Slurp, get the liang pi. Four people who share your thing about sweetness ' +
      'picked it, and it arrives cold.';
    expect(codes(text, belowFloor)).toContain('twin_without_support');
  });

  it('still forbids twin language when lift is below the delta', () => {
    const noLift = twinPacket({
      twinSupport: {
        n: 12,
        lift: CONSTANTS.LIFT_DELTA,
        kFloorMet: true,
        clusterDescriptor: 'people who avoid sweetness in savory food',
      },
    });
    // Everyone likes it, so it is a billboard, not word of mouth.
    expect(twinChannelAllowed(noLift)).toBe(false);
    const text =
      'Hunan Slurp, get the liang pi. Twelve people who share your palate picked it, ' +
      'and it arrives cold.';
    expect(codes(text, noLift)).toContain('twin_without_support');
  });
});

// ---------------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------------

describe('length', () => {
  it('catches five sentences', () => {
    const text =
      'Hunan Slurp, get the liang pi. It sits at the low end of sweetness in savory food. ' +
      'It is not what the room does here. The room orders noodles. It arrives cold, so ' +
      'skip it if you want something hot.';
    expect(splitSentences(text)).toHaveLength(5);
    expect(codes(text, soloPacket())).toContain('too_long');
  });

  it('accepts exactly four sentences', () => {
    const text =
      'Hunan Slurp, get the liang pi. It sits at the low end of sweetness in savory food. ' +
      'The room orders noodles instead. It arrives cold, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).not.toContain('too_long');
  });

  it('catches a one line slogan', () => {
    expect(codes('Hunan Slurp, get the liang pi, it arrives cold.', soloPacket())).toContain(
      'too_short',
    );
  });

  it('catches empty output and reports nothing else', () => {
    const result = validateRendering('   ', soloPacket());
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(['empty']);
  });
});

// ---------------------------------------------------------------------------
// The mandatory downside
// ---------------------------------------------------------------------------

describe('downside', () => {
  it('catches an output that drops the caveat', () => {
    const text =
      'Hunan Slurp, get the liang pi. It sits at the low end of sweetness in savory ' +
      'food, which is not what the room does here, the room orders noodles.';
    expect(codes(text, soloPacket())).toContain('missing_downside');
  });

  it('accepts a caveat rendered in different words', () => {
    // Packet says "served cold, unexpected". Output says "colder than they expected".
    const text =
      'Hunan Slurp, get the liang pi. The room orders noodles instead. It shows up ' +
      'colder than most people expect.';
    expect(codes(text, soloPacket())).not.toContain('missing_downside');
  });

  it('does not demand a caveat when the packet has none', () => {
    const text =
      'Hunan Slurp, get the liang pi. The room orders noodles instead, so this is the ' +
      'contrarian order.';
    expect(codes(text, soloPacket({ caveats: [] }))).not.toContain('missing_downside');
  });

  it('is not satisfied by a vague gesture at having a downside', () => {
    const text =
      'Hunan Slurp, get the liang pi. The room orders noodles instead. A couple of ' +
      'notes exist about it, nothing serious.';
    expect(codes(text, soloPacket())).toContain('missing_downside');
  });
});

// ---------------------------------------------------------------------------
// Hard rules 1 and 3, and the ban on explaining ourselves
// ---------------------------------------------------------------------------

describe('leaks', () => {
  it('catches dietary and religious language, which is never spoken', () => {
    const text =
      'Hunan Slurp, get the liang pi. It is vegan, and it arrives cold, so skip it if ' +
      'you want something hot.';
    expect(codes(text, soloPacket())).toContain('constraint_leak');
  });

  it('catches the algorithm explaining itself', () => {
    const text =
      'Hunan Slurp, get the liang pi. Your vector sits above the cosine threshold for ' +
      'it, and it arrives cold.';
    expect(codes(text, soloPacket())).toContain('algorithm_leak');
  });

  it('catches a number about a person', () => {
    const text =
      'Hunan Slurp, get the liang pi. You are a 94% match for it, and it arrives cold.';
    expect(codes(text, twinPacket())).toContain('number_about_people');
  });

  it('allows a count of people, which is evidence rather than a metric', () => {
    const text =
      'Hunan Slurp, get the liang pi. Six people who share your thing about sweetness ' +
      'in savory food picked it, and it arrives cold.';
    expect(codes(text, twinPacket())).not.toContain('number_about_people');
  });
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

describe('buildPacketBrief', () => {
  it('never puts the constraint count in the prompt', () => {
    const brief = buildPacketBrief(twinPacket({ constraintsAppliedCount: 3 }));
    expect(brief).not.toMatch(/constraint/i);
    expect(brief).not.toMatch(/\b3\b/);
  });

  it('withholds the twin block entirely when the gate is closed', () => {
    const brief = buildPacketBrief(soloPacket());
    expect(brief).toMatch(/SIMILAR DINERS: none available/);
    expect(brief).not.toMatch(/will not accept sweetness/);
  });

  it('gives the model the cluster description when the gate is open', () => {
    const brief = buildPacketBrief(twinPacket());
    expect(brief).toMatch(/6 people/);
    // lift is a metric with no spoken form, so the model never sees it.
    expect(brief).not.toMatch(/0\.34|lift/i);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('dryRunRender', () => {
  const shapes: Array<[string, EvidencePacket]> = [
    ['twin, baseline, caveat', twinPacket()],
    ['twin, no baseline', twinPacket({ populationBaseline: undefined })],
    ['twin, no caveat', twinPacket({ caveats: [] })],
    ['no twin, baseline, caveat', soloPacket()],
    ['no twin, no baseline, no caveat', soloPacket({ populationBaseline: undefined, caveats: [] })],
    ['no axes at all', soloPacket({ userAxes: [], caveats: [] })],
    ['low confidence', soloPacket({ confidence: 'low' })],
    ['low confidence, no caveat', soloPacket({ confidence: 'low', caveats: [] })],
    [
      'twin below the k floor',
      twinPacket({
        twinSupport: { n: 3, lift: 0.4, kFloorMet: false, clusterDescriptor: 'people who avoid sweetness' },
      }),
    ],
    [
      'extraction caveat rather than a twin note',
      soloPacket({ caveats: [{ source: 'extraction', n: 0, claim: 'the menu text is thin on this one' }] }),
    ],
  ];

  for (const [name, packet] of shapes) {
    it(`passes its own validator: ${name}`, () => {
      const text = dryRunRender(packet);
      const result = validateRendering(text, packet);
      expect(result.violations, text).toEqual([]);
    });

    it(`stays between two and four sentences: ${name}`, () => {
      const n = splitSentences(dryRunRender(packet)).length;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(4);
    });
  }

  it('names the dish and the venue', () => {
    const text = dryRunRender(twinPacket());
    expect(text).toContain('liang pi');
    expect(text).toContain('Hunan Slurp');
  });

  it('names the divergence from the room when there is a baseline', () => {
    expect(dryRunRender(twinPacket())).toMatch(/the room orders noodles/);
  });

  it('says nothing about other diners when the twin gate is closed', () => {
    const text = dryRunRender(soloPacket());
    expect(text).not.toMatch(/people|twin|of them|others/i);
  });

  it('is deterministic', () => {
    expect(dryRunRender(twinPacket())).toBe(dryRunRender(twinPacket()));
  });
});

// ---------------------------------------------------------------------------
// renderRecommendation
// ---------------------------------------------------------------------------

describe('renderRecommendation', () => {
  it('returns validated text with no key present', async () => {
    const packet = twinPacket();
    const out = await renderRecommendation(packet, { dryRun: true, dishId: 'dish_1' });
    expect(validateRendering(out.text, packet).ok).toBe(true);
    expect(out.dishId).toBe('dish_1');
    expect(out.sourceChannel).toBe('twin');
    expect(out.packetId).toMatch(/^pkt_/);
  });

  it('derives a stable packet id for the same packet', async () => {
    const a = await renderRecommendation(twinPacket(), { dryRun: true });
    const b = await renderRecommendation(twinPacket(), { dryRun: true });
    expect(a.packetId).toBe(b.packetId);
  });

  it('accepts a caller supplied packet id', async () => {
    const out = await renderRecommendation(twinPacket(), { dryRun: true, packetId: 'pkt_fixed' });
    expect(out.packetId).toBe('pkt_fixed');
  });

  it('retries when the first attempt breaks a rule, and keeps the repair', async () => {
    const packet = soloPacket();
    const attempts: string[] = [];
    const generate = async (req: GenerateRequest): Promise<string> => {
      attempts.push(JSON.stringify(req.messages[req.messages.length - 1].content));
      return attempts.length === 1
        ? 'Hunan Slurp, get the liang pi. Six people like you picked it, and it is delicious!'
        : SOLO_BASE;
    };

    const out = await renderRecommendation(packet, { generate });
    expect(out.text).toBe(SOLO_BASE);
    expect(attempts).toHaveLength(2);
    // The repair turn must name the specific offending spans, not just say "try again".
    expect(attempts[1]).toMatch(/delicious/);
    expect(attempts[1]).toMatch(/people like/);
  });

  it('fails loudly rather than returning text that never validated', async () => {
    const bad = 'Hunan Slurp, get the liang pi. It is absolutely delicious!';
    let calls = 0;
    const generate = async (): Promise<string> => {
      calls += 1;
      return bad;
    };

    await expect(renderRecommendation(soloPacket(), { generate, maxAttempts: 3 })).rejects.toThrow(
      RenderValidationError,
    );
    expect(calls).toBe(3);
  });

  it('carries the violations and the last attempt on the thrown error', async () => {
    const bad = 'Hunan Slurp, get the dan dan noodles. Six people like you picked it.';
    let err: RenderValidationError | null = null;
    try {
      await renderRecommendation(soloPacket(), { generate: async () => bad, maxAttempts: 2 });
    } catch (e) {
      err = e as RenderValidationError;
    }

    expect(err).toBeInstanceOf(RenderValidationError);
    if (!err) throw new Error('unreachable');
    expect(err.lastText).toBe(bad);
    expect(err.attempts).toBe(2);
    expect(err.violations.map((v) => v.code)).toContain('ungrounded_name');
    expect(err.violations.map((v) => v.code)).toContain('twin_without_support');
  });

  it('strips a preamble and surrounding quotes before validating', async () => {
    const out = await renderRecommendation(soloPacket(), {
      generate: async () => `Here is the recommendation:\n\n"${SOLO_BASE}"`,
    });
    expect(out.text).toBe(SOLO_BASE);
  });

  it('takes the deterministic path when there is no key, with no transport in play', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const packet = twinPacket();
      const out = await renderRecommendation(packet);
      // Byte for byte the dry render, which is only true if no call was made.
      expect(out.text).toBe(dryRunRender(packet));
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('lets a supplied transport override the dry-run default', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const out = await renderRecommendation(soloPacket(), { generate: async () => SOLO_BASE });
      expect(out.text).toBe(SOLO_BASE);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Second pass, written against the validator rather than against the model.
//
// Everything below got through the validator at some point. The first pass
// tested the outputs a model produces; these are the outputs it produces once
// it has been told no. A rule that is enforced by a word list is enforced only
// against the wordings someone thought of, so each of these is a different way
// of making the same forbidden claim while owning none of the vocabulary.
// ---------------------------------------------------------------------------

describe('twin language as a concept rather than a phrase', () => {
  // Every one of these asserts that a group of diners exists and resembles the
  // reader. None of them contains "twin", "people like you", or "who share".
  const smuggled: Array<[string, string]> = [
    ['a handful of regulars', 'Hunan Slurp, get the liang pi. A handful of regulars swear by it, and it arrives cold, so skip it if you want it hot.'],
    ['a few of the regulars', 'Hunan Slurp, get the liang pi. A few of the regulars order it, and it arrives cold, so skip it if you want it hot.'],
    ['half a dozen regulars', 'Hunan Slurp, get the liang pi. Half a dozen regulars order it, and it arrives cold, so skip it if you want it hot.'],
    ['others with your palate', 'Hunan Slurp, get the liang pi. It gets ordered by others with your palate, and it arrives cold, so skip it if you want it hot.'],
    ['the ones with your palate', 'Hunan Slurp, get the liang pi. The ones with your palate order it, and it arrives cold, so skip it if you want it hot.'],
    ['palates like yours', 'Hunan Slurp, get the liang pi. It lands with palates like yours, and it arrives cold, so skip it if you want it hot.'],
    ['everybody with your taste', 'Hunan Slurp, get the liang pi. It is what everybody with your taste orders, and it arrives cold, so skip it if you want it hot.'],
    ['regulars who eat the way you do', 'Hunan Slurp, get the liang pi. It is what the regulars who eat the way you do order, and it arrives cold, so skip it if you want it hot.'],
    ['a small group that eats like you', 'Hunan Slurp, get the liang pi. It is the pick of a small group that eats the way you do, and it arrives cold, so skip it if you want it hot.'],
    ['a couple of diners I trust', 'Hunan Slurp, get the liang pi. A couple of diners I trust ordered it, and it arrives cold, so skip it if you want it hot.'],
    ['the people I would trust for you', "Hunan Slurp, get the liang pi. It is the pick of the people I would trust for you, and it arrives cold, so skip it if you want it hot."],
    ['people whose ratings line up', 'Hunan Slurp, get the liang pi. People whose ratings line up with yours order it, and it arrives cold, so skip it if you want it hot.'],
    ['the same aversion, stated as a group', 'Hunan Slurp, get the liang pi. The regulars with the same aversion order it, and it arrives cold, so skip it if you want it hot.'],
    ['a few of us', 'Hunan Slurp, get the liang pi. A few of us order it, and it arrives cold, so skip it if you want it hot.'],
    ['the kind of person who avoids sweetness', 'Hunan Slurp, get the liang pi. It is the order for the kind of person who avoids sweetness, and it arrives cold, so skip it if you want it hot.'],
    ['a regular who avoids sweetness', 'Hunan Slurp, get the liang pi. A regular here who avoids sweetness put me onto it, and it arrives cold, so skip it if you want it hot.'],
  ];

  for (const [name, text] of smuggled) {
    it(`catches ${name}`, () => {
      expect(codes(text, soloPacket())).toContain('twin_without_support');
    });
  }

  it('catches a cohort defined by the reader\'s own axis with the reader left implicit', () => {
    // No "you", no "similar", no count. The only reason this crowd is worth
    // mentioning is that the reader is in it, which is the fabricated claim.
    const text =
      'Hunan Slurp, get the liang pi. The sweetness-averse crowd here orders it, and it ' +
      'arrives cold, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).toContain('twin_without_support');
  });

  it('still allows the axes themselves, which are packet fields', () => {
    const text =
      'Hunan Slurp, get the liang pi. It sits at the low end of sweetness in savory food, ' +
      'where you sit. It arrives cold, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).not.toContain('twin_without_support');
  });

  it('allows the same smuggled wordings once the packet actually has twin support', () => {
    for (const [, text] of smuggled) {
      expect(codes(text, twinPacket())).not.toContain('twin_without_support');
    }
  });
});

describe('enthusiasm that owns none of the banned words', () => {
  const cases: Array<[string, string]> = [
    ['a genuinely special plate', 'Hunan Slurp, get the liang pi. It is a genuinely special plate, though it arrives cold.'],
    ['you will not regret', 'Hunan Slurp, get the liang pi. You will not regret it, though it arrives cold.'],
    ['unmissable', 'Hunan Slurp, get the liang pi. It is unmissable, though it arrives cold.'],
    ['one of the best', 'Hunan Slurp, get the liang pi. It is one of the best in the city, though it arrives cold.'],
    ['chef\'s kiss', 'Hunan Slurp, get the liang pi. It is a chef’s kiss of a plate, though it arrives cold.'],
    ['worth the trip', 'Hunan Slurp, get the liang pi. It is worth the trip, though it arrives cold.'],
    ['you have to try it', 'Hunan Slurp, get the liang pi. You have to try it, though it arrives cold.'],
    ['ridiculously good', 'Hunan Slurp, get the liang pi. It is ridiculously good, though it arrives cold.'],
    ['a rating out of ten', 'Hunan Slurp, get the liang pi. It is a 10/10 plate, though it arrives cold.'],
    ['an emoticon', 'Hunan Slurp, get the liang pi :). It arrives cold, so skip it if you want something hot.'],
    ['slang enthusiasm', 'Hunan Slurp, get the liang pi. It slaps, though it arrives cold.'],
  ];

  for (const [name, text] of cases) {
    it(`catches ${name}`, () => {
      expect(codes(text, soloPacket())).toContain('enthusiasm');
    });
  }

  it('catches a fullwidth exclamation mark, which is not U+0021', () => {
    const text = 'Hunan Slurp, get the liang pi！ It arrives cold, so skip it if you want it hot.';
    expect(codes(text, soloPacket())).toContain('enthusiasm');
  });

  it('catches a double exclamation mark', () => {
    const text = 'Hunan Slurp, get the liang pi‼ It arrives cold, so skip it if you want it hot.';
    expect(codes(text, soloPacket())).toContain('enthusiasm');
  });

  const outsideTheOldRange: Array<[string, string]> = [
    ['hourglass', '⏳'],
    ['alarm clock', '⏰'],
    ['play button', '▶'],
    ['right arrow', '➡'],
    ['star', '⭐'],
    ['keycap one', '1️⃣'],
  ];
  for (const [name, glyph] of outsideTheOldRange) {
    it(`catches the ${name} emoji`, () => {
      const text = `Hunan Slurp, get the liang pi ${glyph}. It arrives cold, so skip it if you want it hot.`;
      expect(codes(text, soloPacket())).toContain('enthusiasm');
    });
  }

  it('catches a banned phrase written with a smart apostrophe', () => {
    const text = 'Hunan Slurp, get the liang pi. It arrives cold, and you’ll love it anyway.';
    expect(codes(text, soloPacket())).toContain('enthusiasm');
  });

  it('catches a banned phrase split by a non-breaking hyphen', () => {
    const text = 'Hunan Slurp, get the liang pi. It arrives cold, but it is a must‑try.';
    expect(codes(text, soloPacket())).toContain('enthusiasm');
  });

  it('catches a banned word split by a zero width space', () => {
    const text = 'Hunan Slurp, get the liang pi. It is del​icious, though it arrives cold.';
    expect(codes(text, soloPacket())).toContain('enthusiasm');
  });

  it('does not fire on a menu special, which is a thing rather than a claim', () => {
    const text =
      'Hunan Slurp, get the liang pi. Ignore the special and the noodles the room orders. ' +
      'It arrives cold, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).not.toContain('enthusiasm');
  });
});

describe('names that are nearly the packet\'s names', () => {
  it('catches a dish that extends a real dish name', () => {
    // "liang pi" is real. "liang pi noodle soup" is a different order, and the
    // first two words are borrowed to make it look checked.
    const text =
      'Hunan Slurp, get the liang pi noodle soup. It arrives cold, so skip it if you want ' +
      'something hot.';
    expect(codes(text, soloPacket())).toContain('ungrounded_name');
  });

  it('catches an extension that runs past the ordering window', () => {
    const text =
      'Hunan Slurp, get the liang pi cold sesame bowl. It arrives cold, so skip it if you ' +
      'want something hot.';
    expect(codes(text, soloPacket())).toContain('ungrounded_name');
  });

  it('catches a dish spelled with a diacritic the packet does not have', () => {
    const text =
      'Hunan Slurp, get the liàng pi. It arrives cold, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).toContain('ungrounded_name');
  });

  it('catches a venue recombined out of words the packet does own', () => {
    // Every word here is in the packet. The name is not.
    const text =
      'Get the liang pi at Lower East Noodles. It arrives cold, so skip it if you want ' +
      'something hot.';
    expect(codes(text, soloPacket())).toContain('ungrounded_name');
  });

  it('catches a price the packet never gave', () => {
    const text =
      'Hunan Slurp, get the liang pi. It is $6 and it arrives cold, so skip it if you want ' +
      'something hot.';
    expect(codes(text, soloPacket())).toContain('ungrounded_name');
  });

  it('allows the price the packet did give', () => {
    const text =
      'Hunan Slurp, get the liang pi, about $14. The room orders noodles instead, and it ' +
      'arrives cold, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).not.toContain('ungrounded_name');
  });

  it('allows ordinary words after a real dish name', () => {
    const text =
      'Hunan Slurp, get the liang pi over the noodles. It arrives cold, so skip it if you ' +
      'want something hot.';
    expect(codes(text, soloPacket())).not.toContain('ungrounded_name');
  });

  it('allows the real venue in a different case', () => {
    const text =
      'HUNAN SLURP, get the liang pi. It arrives cold, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).not.toContain('ungrounded_name');
  });
});

describe('length, counted in clauses rather than periods', () => {
  it('catches a semicolon chain that reads as one sentence', () => {
    const text =
      'Hunan Slurp, get the liang pi; it sits at the low end of sweetness in savory food; ' +
      'the room orders noodles instead; the chili oil is heavy; it arrives cold. Skip it ' +
      'if you want something hot.';
    expect(splitSentences(text)).toHaveLength(2);
    expect(codes(text, soloPacket())).toContain('too_long');
  });

  it('catches a run of "and" clauses spliced into two sentences', () => {
    const text =
      'Hunan Slurp, get the liang pi, and it sits at the low end of sweetness in savory ' +
      'food, and the room orders noodles instead, and the counter is loud, and the line ' +
      'moves fast, and it arrives cold. Skip it if you want something hot.';
    expect(splitSentences(text)).toHaveLength(2);
    expect(codes(text, soloPacket())).toContain('too_long');
  });

  it('catches a dash chain', () => {
    const text =
      'Hunan Slurp, get the liang pi — it sits low on sweetness — the room orders ' +
      'noodles — the portion is small — it arrives cold. Skip it if you want ' +
      'something hot.';
    expect(codes(text, soloPacket())).toContain('too_long');
  });

  it('still allows one honest "and" clause inside four sentences', () => {
    const text =
      'Hunan Slurp, get the liang pi. The room orders noodles instead, and it arrives ' +
      'cold, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).not.toContain('too_long');
  });

  it('does not count a decimal point as a full stop', () => {
    // Otherwise a one-line slogan buys a second sentence with a price.
    const text = 'Hunan Slurp, get the liang pi for about $14.00 flat and it arrives cold anyway.';
    expect(splitSentences(text)).toHaveLength(1);
    expect(codes(text, soloPacket())).toContain('too_short');
  });

  it('over-counts abbreviations rather than under-counting them', () => {
    // "p.m." inflates the sentence count. That direction is a false rejection,
    // which costs a retry; the other direction would let a wall of text pass.
    const text = 'Hunan Slurp, get the liang pi. Go before 7 p.m. It arrives cold.';
    expect(splitSentences(text).length).toBeGreaterThanOrEqual(3);
  });
});

describe('a downside that is only a downside by vocabulary', () => {
  it('catches a caveat word reused as praise', () => {
    // Contains "cold", so the caveat matcher is satisfied, and the line still
    // sells the dish without warning anyone about anything.
    const text =
      'Hunan Slurp, get the liang pi. It is the coldest, cleanest thing on the menu, and ' +
      'the room orders noodles instead.';
    expect(codes(text, soloPacket())).toContain('missing_downside');
  });

  it('catches a caveat restated as the point of the dish', () => {
    const text =
      'Hunan Slurp, get the liang pi. It is served cold on purpose, which is the whole ' +
      'point, and the room orders noodles instead.';
    expect(codes(text, soloPacket())).toContain('missing_downside');
  });

  it('accepts the same caveat stated as something that could go wrong', () => {
    const text =
      'Hunan Slurp, get the liang pi. The room orders noodles instead. It shows up colder ' +
      'than most people expect, so skip it if you want something hot.';
    expect(codes(text, soloPacket())).not.toContain('missing_downside');
  });
});

describe('the algorithm explained in plain language', () => {
  const cases: Array<[string, string]> = [
    ['correlate, bare form', 'Hunan Slurp, get the liang pi. Your ratings correlate with this one, and it arrives cold, so skip it if you want it hot.'],
    ['based on what you rated', 'Hunan Slurp, get the liang pi. It is here based on what you have rated so far, and it arrives cold, so skip it if you want it hot.'],
    ['your taste profile', 'Hunan Slurp, get the liang pi. Your taste profile points here, and it arrives cold, so skip it if you want it hot.'],
    ['the system ranked it', 'Hunan Slurp, get the liang pi. The system ranked it first for you, and it arrives cold, so skip it if you want it hot.'],
    ['similarity', 'Hunan Slurp, get the liang pi. The similarity is high on this one, and it arrives cold, so skip it if you want it hot.'],
    ['we scored it', 'Hunan Slurp, get the liang pi. We scored it against your profile, and it arrives cold, so skip it if you want it hot.'],
  ];

  for (const [name, text] of cases) {
    it(`catches ${name}`, () => {
      expect(codes(text, soloPacket())).toContain('algorithm_leak');
    });
  }
});

describe('the additions did not break honest copy', () => {
  const honest: Array<[string, string, EvidencePacket]> = [
    ['the target voice', TARGET_VOICE, twinPacket()],
    ['the solo base', SOLO_BASE, soloPacket()],
    [
      'four sentences, axes and divergence',
      'Hunan Slurp, get the liang pi. The room orders noodles. It sits at the low end of ' +
        'sweetness in savory food, where you sit. It arrives cold, which surprises people, ' +
        'so skip it if you want something hot.',
      soloPacket(),
    ],
    [
      'twin voice with the neighborhood named',
      'Hunan Slurp on the Lower East Side, get the liang pi. Six people who eat the way ' +
        'you do picked it. It arrives cold, so skip it if you want something hot.',
      twinPacket(),
    ],
    [
      'low confidence hedge',
      'Hunan Slurp, get the liang pi. This is a lead rather than a promise, the read on it ' +
        'is thin. It arrives cold, which surprises people.',
      soloPacket({ confidence: 'low' }),
    ],
  ];

  for (const [name, text, packet] of honest) {
    it(`passes clean: ${name}`, () => {
      expect(validateRendering(text, packet).violations).toEqual([]);
    });
  }
});
