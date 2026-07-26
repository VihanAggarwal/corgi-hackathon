/**
 * Constraint filter tests. Track C.
 *
 * This is a privacy boundary, so most of what is tested here is what must NOT
 * come out the other side. Every test can fail for a real reason: each one
 * corresponds to a leak of Article 9 data, a consent gate that stopped gating,
 * or a count that stopped being true.
 *
 * No Supabase. Every case runs against an injected in-memory source.
 */

import { describe, expect, it } from 'vitest';
import {
  __testing,
  applyConstraintRows,
  filterCandidatesForUsers,
  inMemoryConstraintSource,
  type ConstraintCandidate,
  type ConstraintFilterResult,
  type ConstraintRow,
} from './constraints';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Dish extends ConstraintCandidate {
  venueName: string;
}

const MENU: Dish[] = [
  { id: 'd1', name: 'Liang pi', description: 'Cold wheat noodles, chili oil, black vinegar', venueName: 'Hunan Slurp' },
  { id: 'd2', name: 'Peanut noodles', description: 'Sesame and peanut butter sauce', venueName: 'Hunan Slurp' },
  { id: 'd3', name: 'Pork belly bun', description: 'Braised pork belly, pickled mustard green', venueName: 'Kopitiam' },
  { id: 'd4', name: 'Shrimp toast', description: 'Fried shrimp paste on brioche', venueName: 'Kopitiam' },
  { id: 'd5', name: 'Cucumber salad', description: 'Smashed cucumber, garlic, black vinegar', venueName: 'Hunan Slurp' },
  { id: 'd6', name: 'Mapo tofu', description: 'Fermented bean, sichuan pepper, minced beef', venueName: 'Hunan Slurp' },
];

function row(userId: string, kind: string, value: string, consented = true): ConstraintRow {
  return { userId, kind, value, consentedAt: consented ? '2026-07-25T18:00:00.000Z' : null };
}

function ids(result: ConstraintFilterResult<Dish>): string[] {
  return result.candidates.map((c) => c.id);
}

// ---------------------------------------------------------------------------
// The leak tests. These are the reason the module exists.
// ---------------------------------------------------------------------------

describe('the result cannot carry a constraint value', () => {
  it('serializes with no trace of kosher or peanut allergy', async () => {
    const source = inMemoryConstraintSource([
      row('u1', 'religious', 'kosher'),
      row('u2', 'allergy', 'peanut allergy'),
    ]);

    const result = await filterCandidatesForUsers(['u1', 'u2'], MENU, source);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('kosher');
    expect(serialized).not.toContain('peanut allergy');
    expect(serialized).not.toContain('peanut');
    expect(serialized).not.toContain('allerg');
    expect(serialized).not.toContain('religious');
    // Owners are as forbidden as values. Rule 3 says never whose.
    expect(serialized).not.toContain('u1');
    expect(serialized).not.toContain('u2');

    // And the filter actually did something, so the absence above is not the
    // absence of work.
    expect(ids(result)).toEqual(['d1', 'd5', 'd6']);
  });

  it('exposes exactly two keys and nothing else', async () => {
    const source = inMemoryConstraintSource([row('u1', 'dietary', 'vegan')]);
    const result = await filterCandidatesForUsers(['u1'], MENU, source);

    expect(Object.keys(result).sort()).toEqual(['appliedCount', 'candidates']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('refuses at runtime to seal a result that grew a forbidden key', () => {
    // The type makes this a compile error. This proves the runtime backstop
    // still fires for code that reached the sealer through a cast, which is how
    // a field actually gets added at hour sixty.
    const smuggled = {
      candidates: [],
      appliedCount: 1,
      values: ['kosher'],
    } as unknown as ConstraintFilterResult<Dish>;

    expect(() => __testing.sealResult(smuggled)).toThrow(/forbidden key/i);
  });

  it('rejects a value-carrying object at compile time', () => {
    // Not an object literal, so excess property checking is not what is being
    // relied on here. The assignment fails only because `values` is typed
    // never, which is the structural guarantee this module claims.
    const carrier: { candidates: Dish[]; appliedCount: number; values: string[] } = {
      candidates: [],
      appliedCount: 0,
      values: ['kosher'],
    };

    // @ts-expect-error string[] is not assignable to never.
    const bad: ConstraintFilterResult<Dish> = carrier;
    expect(bad.appliedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

describe('consent gate', () => {
  it('ignores an unconsented row entirely', async () => {
    const source = inMemoryConstraintSource([row('u1', 'allergy', 'peanut allergy', false)]);
    const result = await filterCandidatesForUsers(['u1'], MENU, source);

    // The peanut dish survives, because we were never allowed to use that row.
    expect(ids(result)).toContain('d2');
    expect(result.appliedCount).toBe(0);
  });

  it('applies the consented row and ignores the unconsented one for the same user', async () => {
    const source = inMemoryConstraintSource([
      row('u1', 'allergy', 'peanut allergy', true),
      row('u1', 'religious', 'kosher', false),
    ]);
    const result = await filterCandidatesForUsers(['u1'], MENU, source);

    expect(ids(result)).not.toContain('d2');
    // Pork survives: the kosher row had no consent, so it does not exist here.
    expect(ids(result)).toContain('d3');
    expect(result.appliedCount).toBe(1);
  });

  it('treats an undefined consentedAt the same as null', () => {
    const rows = [
      { userId: 'u1', kind: 'allergy', value: 'peanut allergy' } as unknown as ConstraintRow,
    ];
    const result = applyConstraintRows(['u1'], MENU, rows);

    expect(result.appliedCount).toBe(0);
    expect(ids(result)).toContain('d2');
  });
});

// ---------------------------------------------------------------------------
// Set intersection
// ---------------------------------------------------------------------------

describe('set intersection', () => {
  it('removes a dish that violates any single attendee constraint', async () => {
    const source = inMemoryConstraintSource([
      row('u1', 'religious', 'halal'),
      row('u2', 'allergy', 'shellfish allergy'),
      row('u3', 'dietary', 'vegetarian'),
    ]);

    const result = await filterCandidatesForUsers(['u1', 'u2', 'u3'], MENU, source);

    // Pork out (halal and vegetarian), shrimp out (shellfish and vegetarian),
    // beef out (vegetarian). Peanut noodles stay: nobody here objects to them.
    expect(ids(result)).toEqual(['d1', 'd2', 'd5']);
    expect(result.appliedCount).toBe(3);
  });

  it('never restores a dish a previous constraint removed', async () => {
    const strict = inMemoryConstraintSource([row('u1', 'dietary', 'vegan')]);
    const strictOnly = await filterCandidatesForUsers(['u1'], MENU, strict);

    const both = inMemoryConstraintSource([
      row('u1', 'dietary', 'vegan'),
      row('u2', 'allergy', 'no cilantro'),
    ]);
    const withSecond = await filterCandidatesForUsers(['u1', 'u2'], MENU, both);

    // Adding a constraint can only shrink the set, which is what makes this an
    // intersection rather than a scoring pass.
    for (const id of ids(withSecond)) expect(ids(strictOnly)).toContain(id);
    expect(ids(withSecond).length).toBeLessThanOrEqual(ids(strictOnly).length);
  });

  it('only considers the users it was asked about', async () => {
    const source = inMemoryConstraintSource([
      row('u1', 'dietary', 'vegetarian'),
      row('stranger', 'allergy', 'peanut allergy'),
    ]);

    // A source that over-returns must not widen the filter. Ask about u1 only.
    const overReturning = {
      async rowsForUsers(): Promise<readonly ConstraintRow[]> {
        return source.rowsForUsers(['u1', 'stranger']);
      },
    };

    const result = await filterCandidatesForUsers(['u1'], MENU, overReturning);
    expect(ids(result)).toContain('d2');
    expect(result.appliedCount).toBe(1);
  });

  it('returns everything and counts zero for an empty attendee set', async () => {
    const source = inMemoryConstraintSource([row('u1', 'dietary', 'vegan')]);
    const result = await filterCandidatesForUsers([], MENU, source);

    expect(ids(result)).toEqual(MENU.map((d) => d.id));
    expect(result.appliedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The count
// ---------------------------------------------------------------------------

describe('appliedCount', () => {
  it('counts a constraint that removed nothing', async () => {
    const source = inMemoryConstraintSource([
      row('u1', 'allergy', 'no durian'),
      row('u2', 'allergy', 'no cilantro'),
    ]);
    const result = await filterCandidatesForUsers(['u1', 'u2'], MENU, source);

    // Nothing on this menu is durian or cilantro. Reporting only the filters
    // that bit would tell the organizer that somebody's constraint matched,
    // which is a fact about that person.
    expect(ids(result)).toEqual(MENU.map((d) => d.id));
    expect(result.appliedCount).toBe(2);
  });

  it('counts each consented row, including two rows for one person', async () => {
    const source = inMemoryConstraintSource([
      row('u1', 'allergy', 'peanut allergy'),
      row('u1', 'religious', 'kosher'),
      row('u2', 'dietary', 'vegetarian'),
      row('u3', 'access', 'step free entrance', false),
    ]);
    const result = await filterCandidatesForUsers(['u1', 'u2', 'u3'], MENU, source);

    expect(result.appliedCount).toBe(3);
    expect(typeof result.appliedCount).toBe('number');
    expect(Number.isInteger(result.appliedCount)).toBe(true);
  });

  it('is a plain integer with no way to reach the values behind it', async () => {
    const source = inMemoryConstraintSource([row('u1', 'religious', 'kosher')]);
    const result = await filterCandidatesForUsers(['u1'], MENU, source);

    expect(result.appliedCount).toBe(1);
    // Nothing hanging off the number, nothing hanging off the result.
    expect(Object.getOwnPropertyNames(result).sort()).toEqual(['appliedCount', 'candidates']);
  });
});

// ---------------------------------------------------------------------------
// Candidate handling
// ---------------------------------------------------------------------------

describe('candidates', () => {
  it('preserves order and returns the caller\'s own objects', async () => {
    const source = inMemoryConstraintSource([row('u1', 'dietary', 'vegetarian')]);
    const result = await filterCandidatesForUsers(['u1'], MENU, source);

    expect(ids(result)).toEqual(['d1', 'd2', 'd5']);
    expect(result.candidates[0]).toBe(MENU[0]);
    expect(result.candidates[0].venueName).toBe('Hunan Slurp');
  });

  it('collapses duplicate ids to the first occurrence', () => {
    const dupes = [MENU[0], MENU[0], MENU[4]];
    const result = applyConstraintRows(['u1'], dupes, []);
    expect(ids(result)).toEqual(['d1', 'd5']);
  });

  it('keeps a dish whose tag claims compliance', () => {
    const vegan: Dish = {
      id: 'd7',
      name: 'Vegan bacon bun',
      description: 'Smoked mushroom, no pork anywhere near it',
      tags: ['vegan'],
      venueName: 'Kopitiam',
    };
    const result = applyConstraintRows(['u1'], [vegan, MENU[2]], [row('u1', 'dietary', 'vegan')]);

    // The tag beats the word "bacon" in the name. The real pork bun does not.
    expect(ids(result)).toEqual(['d7']);
  });

  it('keeps a dish tagged peanut free despite a cross contamination note', () => {
    const safe: Dish = {
      id: 'd8',
      name: 'Rice cake',
      description: 'Fried in a kitchen that also handles peanut oil',
      tags: ['peanut free'],
      venueName: 'Kopitiam',
    };
    const result = applyConstraintRows(['u1'], [safe], [row('u1', 'allergy', 'peanut allergy')]);
    expect(ids(result)).toEqual(['d8']);
  });
});

// ---------------------------------------------------------------------------
// Value to terms
// ---------------------------------------------------------------------------

describe('exclusion rules', () => {
  it('maps a diet label to ingredients rather than to itself', () => {
    const rule = __testing.exclusionRuleFor('kosher');
    expect(rule.terms).toContain('pork');
    expect(rule.terms).toContain('shrimp');
    // The label itself is not a term: a kosher deli sandwich is not a violation.
    expect(rule.terms).not.toContain('kosher');
  });

  it('strips the shape words so three spellings agree', () => {
    const a = __testing.exclusionRuleFor('peanut allergy');
    const b = __testing.exclusionRuleFor('no peanuts');
    const c = __testing.exclusionRuleFor('peanut free');
    expect(a.terms).toEqual(b.terms);
    expect(b.terms).toEqual(c.terms);
  });

  it('falls back to the value\'s own words for a constraint it has never seen', () => {
    const rule = __testing.exclusionRuleFor('no cilantro');
    expect(rule.terms).toEqual(['cilantro']);
  });

  it('yields no terms, and therefore removes nothing, for a value that is all shape words', () => {
    const rule = __testing.exclusionRuleFor('severe allergy');
    expect(rule.terms).toEqual([]);
    const result = applyConstraintRows(['u1'], MENU, [row('u1', 'allergy', 'severe allergy')]);
    expect(ids(result)).toEqual(MENU.map((d) => d.id));
    // Still counted. It was applied, it just matched nothing.
    expect(result.appliedCount).toBe(1);
  });

  it('matches whole words only', () => {
    const halal = __testing.exclusionRuleFor('halal');
    // "ham" is a term. "hamachi" is a fish, and excluding it would be the
    // substring bug this matcher exists to avoid.
    expect(halal.terms).toContain('ham');
    expect(__testing.ruleExcludes(halal, __testing.haystack({ id: 'x', name: 'Hamachi crudo' }), [])).toBe(false);
    expect(__testing.ruleExcludes(halal, __testing.haystack({ id: 'y', name: 'Ham and cheese' }), [])).toBe(true);
  });

  it('matches a naive plural', () => {
    const rule = __testing.exclusionRuleFor('peanut allergy');
    expect(__testing.ruleExcludes(rule, __testing.haystack({ id: 'x', name: 'Boiled peanuts' }), [])).toBe(true);
  });

  // ATTACK: a value that is itself the name of an Object.prototype member.
  //
  // EXCLUSION_LEXICON is a plain object literal indexed with an attendee's own
  // words. `EXCLUSION_LEXICON['constructor']` walks the prototype chain and
  // returns the Object constructor function rather than undefined, which is
  // truthy, so exclusionRuleFor accepted it as a term list. Every consumer of
  // that list assumes an array: ruleExcludes does `for (const term of
  // rule.terms)`, which throws on a function. One attendee entering the word
  // "constructor" as a dietary constraint therefore crashed the whole set
  // intersection (and the enterprise dinner request with it) rather than being
  // treated as an ordinary, if odd, word to filter on. Not a value disclosure,
  // but an attacker-controlled string reaching a bare property lookup on an
  // object is exactly the shape of bug this module cannot afford.
  it('does not resolve a constraint value to an inherited Object.prototype member', () => {
    const rule = __testing.exclusionRuleFor('constructor');
    expect(Array.isArray(rule.terms)).toBe(true);
    expect(rule.terms).toEqual(['constructor']);

    expect(() =>
      applyConstraintRows(
        ['u1'],
        MENU,
        [row('u1', 'dietary', 'constructor')],
      ),
    ).not.toThrow();

    const result = applyConstraintRows(['u1'], MENU, [row('u1', 'dietary', 'constructor')]);
    // No dish on the fixture menu is literally named "constructor", so the
    // filter should apply the constraint and remove nothing, not crash.
    expect(ids(result)).toEqual(MENU.map((d) => d.id));
    expect(result.appliedCount).toBe(1);
  });

  it('lexiconLookup refuses every own-property of a plain object, not just "constructor"', () => {
    // toString and hasOwnProperty stay case-sensitive and never match because
    // tokenize lowercases everything, but constructor is the one all-lowercase
    // inherited member and the one the guard exists for.
    expect(__testing.lexiconLookup('constructor')).toBeUndefined();
    expect(__testing.lexiconLookup('toString')).toBeUndefined();
    expect(__testing.lexiconLookup('hasOwnProperty')).toBeUndefined();
    expect(__testing.lexiconLookup('peanut')).toBeDefined();
  });
});
