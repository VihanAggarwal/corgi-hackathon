/**
 * Palate portrait tests. Track A.
 *
 * The portrait is the one screen a judge will read closely, and the two ways it
 * can fail are both silent: it can become a horoscope (only compliments, so it
 * proves nothing), or it can leak a number about a person (rule 1). Every test
 * here defends one of those, or defends the claim that the prose actually
 * tracks the data rather than sounding like it does.
 */

import { describe, expect, it } from 'vitest';
import { AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../contracts/axes';
import type { PalateRegion, UserVector } from '../contracts/types';
import {
  composeBody,
  derivePortraitPacket,
  deriveUnflatteringCandidates,
  describeVolumeChange,
  dryRunDraft,
  findViolations,
  generatePalatePortrait,
  verifyUnflattering,
  __testing,
  type DraftGenerator,
  type PortraitDraft,
  type PortraitInput,
  type PortraitPacket,
} from './portrait';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function theta(values: Partial<Record<AxisKey, number>>): number[] {
  const t = new Array(AXIS_COUNT).fill(0);
  for (const [k, v] of Object.entries(values)) t[AXIS_KEYS.indexOf(k as AxisKey)] = v as number;
  return t;
}

function user(values: Partial<Record<AxisKey, number>>, nComparisons = 40): UserVector {
  return {
    theta: theta(values),
    nComparisons,
    posteriorVar: 0.2,
    updatedAt: '2026-07-26T00:00:00.000Z',
  };
}

function region(volume: number, explored: AxisKey[], frontier: AxisKey[]): PalateRegion {
  return {
    volume,
    exploredAxes: explored,
    frontierAxes: frontier,
    measuredAt: '2026-07-26T00:00:00.000Z',
  };
}

const EXPLORED: AxisKey[] = [
  'heat_capsaicin',
  'acid',
  'funk_ferment',
  'char_smoke',
  'texture_crunch',
  'umami_depth',
];

/**
 * A person with real opinions: loves heat and funk, refuses sweetness in savory
 * food, mildly avoids bitterness, and has never positively rated either of the
 * two refused axes in either window.
 */
function baseInput(overrides: Partial<PortraitInput> = {}): PortraitInput {
  return {
    userId: 'u_1',
    user: user({
      heat_capsaicin: 2.0,
      sweetness_savory: -2.4,
      funk_ferment: 1.6,
      bitterness: -0.9,
    }),
    logs: [
      { dishName: 'mapo tofu', rating: 5 },
      { dishName: 'grilled octopus', rating: 4 },
      { dishName: 'salt cod fritters', rating: 4 },
      { dishName: 'pork and chive dumplings', rating: 3 },
      { dishName: 'honey walnut shrimp', rating: 2 },
      { dishName: 'creamed corn', rating: 1 },
    ],
    // exp(1.693 - 1.0) is about 2, so the region roughly doubled.
    regionBefore: region(1.0, EXPLORED.slice(0, 5), ['sweetness_savory', 'bitterness']),
    regionAfter: region(1.693, EXPLORED, ['sweetness_savory', 'bitterness']),
    ...overrides,
  };
}

async function generate(input: PortraitInput, draft?: DraftGenerator) {
  return generatePalatePortrait(input, { draft: draft ?? dryRunDraft });
}

/** A draft that reads like every AI personality product ever shipped. */
const flatteringDraft: DraftGenerator = (packet) => ({
  opening: 'You have a bold and adventurous palate that most people would envy.',
  unflattering: `You bring a wonderful openness to ${packet.unflattering.anchor}.`,
  volume: `Your palate ${packet.volume.phrase}, and ${packet.volume.refusedLabel ?? 'everything'} is next.`,
});

// ---------------------------------------------------------------------------
// Rule 1: no numbers about people
// ---------------------------------------------------------------------------

describe('no numbers about people', () => {
  it('generates a portrait with no digit anywhere in it', async () => {
    const p = await generate(baseInput());
    expect(p.body).not.toMatch(/\d/);
    expect(p.body.length).toBeGreaterThan(40);
  });

  it('rejects a draft that reports a percentile, even a true one', async () => {
    const packet = derivePortraitPacket(baseInput());
    const good = await dryRunDraft(packet, 0, []);
    const withNumber: PortraitDraft = {
      ...good,
      opening: 'You are in the bottom 4 percent on sweetness.',
    };
    expect(findViolations(withNumber, packet)).toContain('contains a digit');
  });

  it('keeps a dish whose name contains a digit out of the packet entirely', () => {
    const packet = derivePortraitPacket(
      baseInput({
        logs: [
          { dishName: 'No. 7 noodles', rating: 5 },
          { dishName: 'chili oil wontons', rating: 5 },
        ],
      }),
    );
    // The renderer cannot speak that name without breaking rule 1, so it must
    // never be offered as evidence in the first place.
    expect(packet.favoriteDishes).toEqual(['chili oil wontons']);
  });

  it('sends no number of any kind to the model', () => {
    const packet = derivePortraitPacket(baseInput());
    // The model cannot leak a figure about this person that it never received.
    expect(__testing.promptPayload(packet)).not.toMatch(/\d/);
    expect(__testing.systemPrompt(packet)).not.toMatch(/\d/);
    expect(__testing.promptPayload(packet)).not.toContain('u_1');
  });
});

// ---------------------------------------------------------------------------
// The horoscope check
// ---------------------------------------------------------------------------

describe('the unflattering claim', () => {
  it('is verified rather than trusted, and is true on a real portrait', async () => {
    const input = baseInput();
    const packet = derivePortraitPacket(input);
    const p = await generate(input);

    expect(p.containsUnflattering).toBe(true);
    // The claim is in a known position, so this is a real containment check
    // rather than an interpretation of the paragraph.
    expect(p.body).toContain(packet.unflattering.claim);
  });

  it('rejects an all-complimentary draft', () => {
    const packet = derivePortraitPacket(baseInput());
    const violations = findViolations(flatteringDraft(packet, 0, []) as PortraitDraft, packet);
    expect(violations.join(' ')).toContain('does not carry the derived claim');
  });

  it('fails loudly when the model will not produce a criticism', async () => {
    let calls = 0;
    const stubborn: DraftGenerator = (packet, attempt, prior) => {
      calls++;
      // A retry is told what it broke. This model ignores it, which is the case
      // the hard failure exists for.
      if (attempt > 0) expect(prior.length).toBeGreaterThan(0);
      return flatteringDraft(packet, attempt, prior);
    };

    await expect(
      generatePalatePortrait(baseInput(), { draft: stubborn, maxAttempts: 3 }),
    ).rejects.toThrow(/failed verification after 3 attempts/);
    expect(calls).toBe(3);
  });

  it('accepts a corrected second attempt and reports the retry as clean', async () => {
    let calls = 0;
    const fixesItself: DraftGenerator = async (packet, attempt, prior) => {
      calls++;
      if (attempt === 0) return flatteringDraft(packet, attempt, prior);
      expect(prior.join(' ')).toContain('does not carry the derived claim');
      return dryRunDraft(packet, attempt, prior);
    };

    const p = await generatePalatePortrait(baseInput(), { draft: fixesItself });
    expect(calls).toBe(2);
    expect(p.containsUnflattering).toBe(true);
  });

  it('rejects a sentence that keeps the anchor and inverts the polarity', () => {
    const packet = derivePortraitPacket(baseInput());
    // This carries the anchor phrase and a negative word, and it is still
    // flattery. The praise gate exists for exactly this sentence.
    expect(
      verifyUnflattering(
        'You are not afraid of sweetness in savory food.',
        packet.unflattering,
      ),
    ).toBe(false);
    expect(
      verifyUnflattering(
        'You have never once accepted sweetness in savory food.',
        packet.unflattering,
      ),
    ).toBe(true);
  });

  it('rejects a criticism about an axis we did not derive', () => {
    const packet = derivePortraitPacket(baseInput());
    expect(
      verifyUnflattering('You never touch anything with numbing heat.', packet.unflattering),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Derivation: the criticism comes from data, never from the model
// ---------------------------------------------------------------------------

describe('deriveUnflatteringCandidates', () => {
  it('leads with thin evidence for a user we barely know', () => {
    const input = baseInput({
      user: user({ heat_capsaicin: 2.0, sweetness_savory: -2.4 }, 6),
    });
    const top = deriveUnflatteringCandidates(input)[0];
    expect(top.kind).toBe('thin_evidence');
    // Saying anything sharper on six duels would be the model inventing a person.
    expect(top.claim).toContain('not enough');
  });

  it('names a persistently refused axis when the evidence is there', () => {
    const top = deriveUnflatteringCandidates(baseInput())[0];
    expect(top.kind).toBe('refused_axis');
    expect(top.axis).toBe('sweetness_savory');
    expect(top.anchor).toBe('sweetness in savory food');
  });

  it('does not call an axis refused when it only just reached the frontier', () => {
    // Present in `after` but not in `before`: they have not turned it down over
    // a window, they have simply not got there yet.
    const input = baseInput({
      regionBefore: region(1.0, EXPLORED.slice(0, 5), []),
      regionAfter: region(1.693, EXPLORED, ['sweetness_savory', 'bitterness']),
    });
    const kinds = deriveUnflatteringCandidates(input).map((c) => c.kind);
    expect(kinds).not.toContain('refused_axis');
    expect(kinds[0]).toBe('strong_rejection');
  });

  it('calls out ratings that never discriminate', () => {
    const input = baseInput({
      logs: [
        { dishName: 'mapo tofu', rating: 5 },
        { dishName: 'grilled octopus', rating: 5 },
        { dishName: 'salt cod fritters', rating: 4 },
        { dishName: 'pork and chive dumplings', rating: 5 },
        { dishName: 'lamb skewers', rating: 4 },
        { dishName: 'clams and beans', rating: 5 },
      ],
    });
    const kinds = deriveUnflatteringCandidates(input).map((c) => c.kind);
    expect(kinds).toContain('undiscriminating');
  });

  it('does not call a discriminating rater undiscriminating', () => {
    const kinds = deriveUnflatteringCandidates(baseInput()).map((c) => c.kind);
    expect(kinds).not.toContain('undiscriminating');
  });

  it('always produces a claim, even for a user with no opinions and no logs', () => {
    const input = baseInput({
      user: user({}, 200),
      logs: [],
      regionBefore: region(2, [], []),
      regionAfter: region(2, [], []),
    });
    const top = deriveUnflatteringCandidates(input)[0];
    expect(top.claim.length).toBeGreaterThan(20);
    // Whatever it says, it has to survive the same verification a model draft does.
    expect(verifyUnflattering(top.claim, top)).toBe(true);
  });

  it('produces a claim that passes its own verification for every kind', () => {
    for (const c of deriveUnflatteringCandidates(baseInput())) {
      expect(verifyUnflattering(c.claim, c)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The palate volume line
// ---------------------------------------------------------------------------

describe('the volume line', () => {
  it('reflects real growth between the two regions', async () => {
    const p = await generate(baseInput());
    // exp(1.693 - 1.0) is about two.
    expect(p.body).toContain('has roughly doubled');
    expect(p.body).not.toContain('narrowed');
  });

  it('reports no movement when the region did not move', async () => {
    const p = await generate(
      baseInput({
        regionBefore: region(1.0, EXPLORED, ['sweetness_savory', 'bitterness']),
        regionAfter: region(1.0, EXPLORED, ['sweetness_savory', 'bitterness']),
      }),
    );
    expect(p.body).toContain('has not really moved');
  });

  it('reports a shrinking region rather than rounding it up to flat', async () => {
    const p = await generate(
      baseInput({
        regionBefore: region(2.0, EXPLORED, ['sweetness_savory', 'bitterness']),
        regionAfter: region(1.2, EXPLORED, ['sweetness_savory', 'bitterness']),
      }),
    );
    expect(p.body).toContain('has narrowed');
  });

  it('moves through distinct phrases as growth increases', () => {
    const before = region(0, EXPLORED, ['bitterness']);
    const phrases = [0.0, 0.2, 0.5, 0.8, 1.2].map(
      (v) => describeVolumeChange(before, region(v, EXPLORED, ['bitterness'])).phrase,
    );
    expect(new Set(phrases).size).toBe(phrases.length);
    expect(phrases[0]).toBe('has not really moved');
    expect(phrases[phrases.length - 1]).toBe('has more than doubled');
  });

  it('treats the volume as a log volume, not a raw one', () => {
    // A raw-difference reading of 1.0 to 2.0 would call this "doubled". As log
    // volumes it is a factor of e, which is more than double.
    const grew = describeVolumeChange(
      region(1.0, EXPLORED, ['bitterness']),
      region(2.0, EXPLORED, ['bitterness']),
    );
    expect(grew.phrase).toBe('has more than doubled');
    expect(grew.direction).toBe('grew');
  });

  it('names the axis the user still refuses', async () => {
    const p = await generate(baseInput());
    expect(p.body).toContain('bitterness');
  });

  it('spends the criticism and the volume line on different axes when it can', () => {
    const packet = derivePortraitPacket(baseInput());
    expect(packet.unflattering.axis).toBe('sweetness_savory');
    expect(packet.volume.refusedAxis).toBe('bitterness');
  });

  it('falls back to the same axis rather than saying nothing when only one is refused', () => {
    const packet = derivePortraitPacket(
      baseInput({
        regionBefore: region(1.0, EXPLORED, ['sweetness_savory']),
        regionAfter: region(1.693, EXPLORED, ['sweetness_savory']),
      }),
    );
    expect(packet.volume.refusedAxis).toBe('sweetness_savory');
  });

  it('says so honestly when there is no refused axis left', async () => {
    const input = baseInput({
      regionBefore: region(1.0, EXPLORED, []),
      regionAfter: region(1.693, EXPLORED, []),
    });
    const packet = derivePortraitPacket(input);
    expect(packet.volume.refusedLabel).toBeNull();
    const p = await generate(input);
    expect(p.body).toContain('has roughly doubled');
  });

  it('rejects a volume sentence that drops the refused axis', () => {
    const packet = derivePortraitPacket(baseInput());
    const draft: PortraitDraft = {
      opening: 'You read as chili heat at seriously hot.',
      unflattering: packet.unflattering.claim,
      volume: 'Your palate has roughly doubled since the last read.',
    };
    expect(findViolations(draft, packet).join(' ')).toContain('does not name the refused axis');
  });

  it('rejects a volume sentence that invents a different amount of growth', () => {
    const packet = derivePortraitPacket(baseInput());
    const draft: PortraitDraft = {
      opening: 'You read as chili heat at seriously hot.',
      unflattering: packet.unflattering.claim,
      volume: 'Your palate has exploded outward, and bitterness is still off the table.',
    };
    expect(findViolations(draft, packet).join(' ')).toContain('missing the phrase');
  });
});

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

describe('voice rules', () => {
  const ENTHUSIASM = [
    "you'll love",
    'amazing',
    'incredible',
    'delicious',
    'obsessed',
    'must try',
  ];

  it('produces no enthusiasm markers', async () => {
    const p = await generate(baseInput());
    expect(p.body).not.toContain('!');
    for (const phrase of ENTHUSIASM) {
      expect(p.body.toLowerCase()).not.toContain(phrase);
    }
  });

  it('rejects each enthusiasm marker in a draft', async () => {
    const packet = derivePortraitPacket(baseInput());
    const good = await dryRunDraft(packet, 0, []);
    for (const phrase of ENTHUSIASM) {
      const draft: PortraitDraft = { ...good, opening: `A note on your palate: ${phrase} it.` };
      expect(findViolations(draft, packet).join(' ')).toContain('enthusiasm marker');
    }
  });

  it('rejects an exclamation point and an emoji', async () => {
    const packet = derivePortraitPacket(baseInput());
    const good = await dryRunDraft(packet, 0, []);
    expect(
      findViolations({ ...good, opening: 'You like heat!' }, packet),
    ).toContain('contains an exclamation point');
    expect(
      findViolations({ ...good, opening: 'You like heat \u{1F525}' }, packet),
    ).toContain('contains emoji');
  });

  it('stays under six sentences', async () => {
    const p = await generate(baseInput());
    const sentences = p.body.split(/[.?]+/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeLessThanOrEqual(5);
  });

  it('rejects a draft that runs long', async () => {
    const packet = derivePortraitPacket(baseInput());
    const good = await dryRunDraft(packet, 0, []);
    const padded: PortraitDraft = {
      ...good,
      opening: 'You like heat. You like funk. You like salt. You like acid. You like char.',
    };
    expect(findViolations(padded, packet)).toContain('longer than five sentences');
  });
});

// ---------------------------------------------------------------------------
// Rule 2: the model renders, it never decides
// ---------------------------------------------------------------------------

describe('grounding', () => {
  it('rejects an axis the packet never mentioned', async () => {
    const packet = derivePortraitPacket(baseInput());
    const good = await dryRunDraft(packet, 0, []);
    const draft: PortraitDraft = {
      ...good,
      opening: 'You want numbing heat and you want it often.',
    };
    expect(findViolations(draft, packet).join(' ')).toContain('ungrounded axis name: numbing heat');
  });

  it('allows an axis name that came out of the packet', async () => {
    const packet = derivePortraitPacket(baseInput());
    const good = await dryRunDraft(packet, 0, []);
    expect(findViolations(good, packet)).toEqual([]);
    expect(packet.allowedLabels).toContain('chili heat');
  });

  it('does not mistake a dish name for an ungrounded axis mention', async () => {
    const input = baseInput({
      logs: [{ dishName: 'Crunch salad', rating: 5 }],
    });
    const packet = derivePortraitPacket(input);
    const good = await dryRunDraft(packet, 0, []);
    // "crunch" is an axis label the packet did not license, but here it is part
    // of a dish name we handed over, which is grounded evidence.
    expect(findViolations(good, packet)).toEqual([]);
  });

  it('only offers axes the user actually has an opinion about', () => {
    const packet = derivePortraitPacket(
      baseInput({ user: user({ heat_capsaicin: 2.0, acid: 0.1 }) }),
    );
    expect(packet.signature.map((s) => s.axis)).toEqual(['heat_capsaicin']);
  });

  it('speaks the pole in the words of the frozen axis table', () => {
    const packet = derivePortraitPacket(baseInput());
    const heat = packet.signature.find((s) => s.axis === 'heat_capsaicin');
    expect(heat?.pole).toBe('seriously hot');
    const sweet = packet.signature.find((s) => s.axis === 'sweetness_savory');
    expect(sweet?.pole).toBe('never');
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe('composeBody', () => {
  it('keeps the criticism between the opening and the volume line', () => {
    const body = composeBody({ opening: 'A.', unflattering: 'B.', volume: 'C.' });
    expect(body).toBe('A. B. C.');
  });

  it('returns a portrait for the contract shape callers expect', async () => {
    const p = await generate(baseInput());
    expect(p.userId).toBe('u_1');
    expect(typeof p.body).toBe('string');
    expect(p.containsUnflattering).toBe(true);
    expect(Number.isFinite(Date.parse(p.generatedAt))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A sanity read of the whole thing
// ---------------------------------------------------------------------------

describe('the portrait as a whole', () => {
  it('reads as prose about this specific person', async () => {
    const p = await generate(baseInput());
    const packet: PortraitPacket = derivePortraitPacket(baseInput());

    expect(p.body).toContain('chili heat');
    expect(p.body).toContain('sweetness in savory food');
    expect(p.body).toContain('mapo tofu');
    expect(p.body).toContain('bitterness');
    expect(findViolations(await dryRunDraft(packet, 0, []), packet)).toEqual([]);
  });
});
