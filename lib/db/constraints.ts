/**
 * The constraint filter. Track C.
 *
 * Hard rule 3: constraints are filters, never features. Dietary and religious
 * records are GDPR Article 9 special category data. They are applied as a set
 * intersection over the candidate dishes BEFORE any model call, they never
 * enter theta, never enter a prompt, never get displayed, and leave this module
 * as one non-negative integer and nothing else.
 *
 * WHY THE RETURN TYPE, NOT THE DISCIPLINE
 * "We are careful not to return the values" is a convention, and conventions
 * lose at hour sixty of a hackathon. ConstraintFilterResult types every field
 * that could carry a value, a kind, or an owner as `never`, the same way
 * core/twins.ts ClientTwinView types reliability. Adding
 * `values: [...]` to the returned literal is a compile error, not something a
 * reviewer has to notice by tracing call sites. sealResult() then checks the
 * key set at runtime, because a caller can still spread our result into an
 * object of their own and TypeScript stops watching at the module boundary.
 *
 * WHAT NEVER HAPPENS HERE
 * Nothing in this file logs. Not the rows, not the values, not a count of what
 * each user removed, not even in a caught error. A console line is a log line
 * is a retained record of who is kosher, and the audit story for E1 is
 * "there is no code path", not "we redact it downstream".
 *
 * CONSENT IS A GATE, NOT A PREFERENCE
 * A row with a null consented_at is not usable. Not for the enterprise path,
 * not for the self-declared path, not for the demo. It is dropped here as well
 * as in the SQL, because the SQL predicate is one edit away from being widened
 * by someone debugging an empty result set.
 *
 * NO DATABASE REQUIRED
 * Rows arrive through an injectable ConstraintSource. The Supabase-backed
 * source is one implementation, the in-memory one is another, and the Merge
 * MCP path will be a third, so the filter itself is testable and demoable with
 * no credentials and no network.
 */

import { getServiceClient, hasServiceRoleCredentials } from './client';

// ---------------------------------------------------------------------------
// Inputs. Values may travel IN. Nothing below travels back OUT.
// ---------------------------------------------------------------------------

/**
 * One constraint record, as the filter needs to see it.
 *
 * This mirrors `constraints` in contracts/schema.sql minus the columns the
 * filter has no business reading: `id` and `source` say who told us and
 * therefore make the row easier to attribute back to a person.
 */
export interface ConstraintRow {
  userId: string;
  /**
   * 'allergy' | 'religious' | 'dietary' | 'access'. Free text in the schema.
   * Carried for fidelity with the table and deliberately never used for
   * matching: a filter that behaved differently for kind 'religious' would be a
   * feature computed from Article 9 data, which is exactly hard rule 3.
   */
  kind: string;
  value: string;
  /** ISO timestamp. Null means no consent, which means the row is unusable. */
  consentedAt: string | null;
}

/**
 * A dish as the filter needs to see it.
 *
 * Structural on purpose: callers pass their own richer dish objects and get
 * those same objects back, so the filter never becomes a place where a dish
 * gets reshaped.
 */
export interface ConstraintCandidate {
  id: string;
  name: string;
  description?: string | null;
  /** Menu or extraction tags. A 'vegan' tag is a claim the dish makes about itself. */
  tags?: readonly string[] | null;
}

/** Where rows come from. One method, so a fake is three lines. */
export interface ConstraintSource {
  /**
   * Rows for these users. May over-return, may include unconsented rows: the
   * filter re-scopes and re-gates both, so a sloppy source cannot widen the set.
   */
  rowsForUsers(userIds: readonly string[]): Promise<readonly ConstraintRow[]>;
}

// ---------------------------------------------------------------------------
// The output. This is the privacy boundary.
// ---------------------------------------------------------------------------

/**
 * What the filter returns, and the complete list of what it can return.
 *
 * The `never` fields are the guarantee. Any attempt to hand back the values,
 * the kinds, whose constraints they were, which dishes were removed, or why,
 * fails to typecheck as this type. `removed` and `reasons` are forbidden for
 * the same reason as the values themselves: on a ten dish menu for a party of
 * two, the removed set IS the diagnosis.
 */
export interface ConstraintFilterResult<T> {
  /** The surviving candidates, in the order they were given, deduplicated by id. */
  readonly candidates: readonly T[];
  /** How many consented constraints were applied. The only number that leaves. */
  readonly appliedCount: number;

  readonly values?: never;
  readonly kinds?: never;
  readonly owners?: never;
  readonly userIds?: never;
  readonly subjects?: never;
  readonly rows?: never;
  readonly records?: never;
  readonly constraints?: never;
  readonly removed?: never;
  readonly removedCount?: never;
  readonly excluded?: never;
  readonly reasons?: never;
  readonly byUser?: never;
  readonly matched?: never;
}

/** Every key a ConstraintFilterResult is allowed to have at runtime. */
const RESULT_KEYS: ReadonlySet<string> = new Set(['candidates', 'appliedCount']);

/**
 * Freeze the result and prove its shape.
 *
 * The type system stops at the module boundary and Object.assign does not care
 * about `never`. This is the same check enforced where it cannot be optimised
 * away, and it throws rather than deleting the field, because a filter that
 * quietly repaired a leak would hide the bug that produced it.
 */
function sealResult<T>(result: ConstraintFilterResult<T>): ConstraintFilterResult<T> {
  for (const key of Object.keys(result)) {
    if (!RESULT_KEYS.has(key)) {
      throw new Error(
        `Constraint filter result carries a forbidden key "${key}". ` +
          'Only candidates and appliedCount may leave this module.',
      );
    }
  }
  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// Value to exclusion terms
// ---------------------------------------------------------------------------

/**
 * Words that describe the SHAPE of a constraint rather than its content.
 * "peanut allergy", "no peanuts" and "peanut free" are one constraint written
 * three ways, and the part that matters is the peanut.
 */
const GENERIC_VALUE_TOKENS: ReadonlySet<string> = new Set([
  'a', 'allergen', 'allergic', 'allergies', 'allergy', 'am', 'and', 'any',
  'avoid', 'avoids', 'be', 'cannot', 'cant', 'diet', 'dietary', 'do', 'eat',
  'eats', 'free', 'from', 'i', 'intolerance', 'intolerant', 'is', 'must',
  'my', 'need', 'no', 'none', 'not', 'observant', 'only', 'or', 'reaction',
  'requirement', 'restriction', 'sensitive', 'sensitivity', 'severe', 'strict',
  'to', 'wont',
]);

/** Exclusion terms per constraint. Ingredient words, not diet labels. */
const MEAT_TERMS = [
  'beef', 'pork', 'chicken', 'lamb', 'mutton', 'veal', 'duck', 'turkey',
  'bacon', 'ham', 'prosciutto', 'chorizo', 'pancetta', 'guanciale', 'sausage',
  'meatball', 'steak', 'brisket', 'oxtail', 'lard', 'gelatin', 'bone broth',
  'pepperoni', 'salami', 'pastrami', 'carnitas', 'barbacoa', 'birria',
];

const SEAFOOD_TERMS = [
  'fish', 'anchovy', 'anchovies', 'tuna', 'salmon', 'cod', 'sardine',
  'mackerel', 'bonito', 'fish sauce', 'shrimp', 'prawn', 'crab', 'lobster',
  'crawfish', 'crayfish', 'clam', 'mussel', 'oyster', 'scallop', 'squid',
  'calamari', 'octopus', 'uni', 'roe', 'caviar',
];

const SHELLFISH_TERMS = [
  'shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'crawfish', 'crayfish',
  'clam', 'mussel', 'oyster', 'scallop', 'squid', 'calamari', 'octopus',
];

const DAIRY_TERMS = [
  'milk', 'cheese', 'butter', 'cream', 'creme', 'yogurt', 'yoghurt', 'ghee',
  'paneer', 'mozzarella', 'parmesan', 'pecorino', 'ricotta', 'burrata',
  'queso', 'crema', 'custard', 'gelato', 'labneh', 'feta', 'mascarpone',
];

const EGG_TERMS = ['egg', 'eggs', 'omelet', 'omelette', 'mayo', 'mayonnaise', 'aioli', 'meringue', 'custard'];

const PEANUT_TERMS = ['peanut', 'peanuts', 'groundnut', 'groundnuts', 'satay', 'peanut butter', 'peanut oil'];

const TREE_NUT_TERMS = [
  'almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut', 'macadamia',
  'praline', 'marzipan', 'nutella', 'pine nut',
];

const GLUTEN_TERMS = [
  'wheat', 'flour', 'bread', 'brioche', 'baguette', 'bun', 'pasta', 'noodle',
  'noodles', 'ramen', 'udon', 'breaded', 'panko', 'seitan', 'barley', 'rye',
  'couscous', 'orzo', 'dumpling', 'wonton', 'pastry', 'croissant', 'crouton',
];

const ALCOHOL_TERMS = [
  'wine', 'beer', 'rum', 'vodka', 'whiskey', 'whisky', 'bourbon', 'sake',
  'mirin', 'liqueur', 'brandy', 'cognac', 'tequila', 'gin', 'vermouth',
];

const PORK_TERMS = [
  'pork', 'bacon', 'ham', 'prosciutto', 'chorizo', 'pancetta', 'guanciale',
  'lard', 'carnitas', 'char siu', 'pepperoni', 'salami', 'speck',
];

const EXCLUSION_LEXICON: Readonly<Record<string, readonly string[]>> = {
  peanut: PEANUT_TERMS,
  peanuts: PEANUT_TERMS,
  'tree nut': TREE_NUT_TERMS,
  'tree nuts': TREE_NUT_TERMS,
  nut: [...PEANUT_TERMS, ...TREE_NUT_TERMS],
  nuts: [...PEANUT_TERMS, ...TREE_NUT_TERMS],
  shellfish: SHELLFISH_TERMS,
  crustacean: SHELLFISH_TERMS,
  fish: ['fish', 'anchovy', 'anchovies', 'tuna', 'salmon', 'cod', 'sardine', 'mackerel', 'bonito', 'fish sauce'],
  seafood: SEAFOOD_TERMS,
  dairy: DAIRY_TERMS,
  lactose: DAIRY_TERMS,
  milk: DAIRY_TERMS,
  egg: EGG_TERMS,
  eggs: EGG_TERMS,
  gluten: GLUTEN_TERMS,
  wheat: GLUTEN_TERMS,
  celiac: GLUTEN_TERMS,
  coeliac: GLUTEN_TERMS,
  sesame: ['sesame', 'tahini', 'halva', 'za atar'],
  soy: ['soy', 'soya', 'tofu', 'edamame', 'miso', 'tempeh', 'soy sauce'],
  pork: PORK_TERMS,
  beef: ['beef', 'steak', 'brisket', 'veal', 'oxtail', 'pastrami', 'birria'],
  alcohol: ALCOHOL_TERMS,
  vegetarian: [...MEAT_TERMS, ...SEAFOOD_TERMS],
  vegan: [...MEAT_TERMS, ...SEAFOOD_TERMS, ...DAIRY_TERMS, ...EGG_TERMS, 'honey'],
  pescatarian: MEAT_TERMS,
  halal: [...PORK_TERMS, ...ALCOHOL_TERMS],
  kosher: [...PORK_TERMS, ...SHELLFISH_TERMS, 'catfish', 'eel'],
};

/** Fold text to lowercase words separated by single spaces, padded for matching. */
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function tokenize(text: string): string[] {
  return normalize(text).trim().split(' ').filter(Boolean);
}

/**
 * A constraint reduced to the two things the filter uses: a label for matching
 * a dish's own compliance claim, and the ingredient terms that disqualify a
 * dish. Internal. It carries a value-derived string and therefore never leaves.
 */
interface ExclusionRule {
  label: string;
  terms: readonly string[];
}

/**
 * Look up a key in EXCLUSION_LEXICON without walking the prototype chain.
 *
 * EXCLUSION_LEXICON is an object literal, so a bare `EXCLUSION_LEXICON[key]`
 * resolves inherited members of Object.prototype when `key` collides with one.
 * A self-declared constraint whose value is literally "constructor" tokenizes
 * to the single word "constructor" (tokenize already strips the non-alphanumeric
 * characters that would defuse "__proto__" the same way), and
 * `EXCLUSION_LEXICON['constructor']` then returns the Object constructor
 * function rather than undefined: truthy, so the whole-label branch below
 * accepted it as a term list, and every other caller in this file assumes a
 * term list is an array. `ruleExcludes` then does `for (const term of
 * rule.terms)` and a function is not iterable, so a single attendee entering
 * "constructor" as their dietary constraint took down the whole dinner
 * request. hasOwnProperty makes the lookup miss the prototype entirely, the
 * same value a real dish menu can never accidentally trigger.
 */
function lexiconLookup(key: string): readonly string[] | undefined {
  return Object.prototype.hasOwnProperty.call(EXCLUSION_LEXICON, key)
    ? EXCLUSION_LEXICON[key]
    : undefined;
}

/**
 * Turn a raw constraint value into exclusion terms.
 *
 * Known values map to an ingredient list, because "kosher" does not appear in
 * the text of a dish that violates it, pork does. Unknown values fall back to
 * their own content words, so a constraint we have never seen ("no cilantro")
 * still filters instead of silently doing nothing. A value that reduces to
 * nothing but generic words yields no terms: it is still counted as applied,
 * because whether a filter matched anything is a fact about the menu, and
 * reporting only the filters that bit would leak which ones did.
 */
function exclusionRuleFor(value: string): ExclusionRule {
  const tokens = tokenize(value).filter((t) => !GENERIC_VALUE_TOKENS.has(t));
  const label = tokens.join(' ');

  const whole = lexiconLookup(label);
  if (whole) return { label, terms: whole };

  // A multi-word value where one word is known: "shellfish and pork" or
  // "severe peanut". Union the known lists rather than falling through to the
  // literal words, which would only match a dish that spells the word out.
  const fromTokens: string[] = [];
  for (const token of tokens) {
    const known = lexiconLookup(token);
    if (known) fromTokens.push(...known);
  }
  if (fromTokens.length > 0) return { label, terms: [...new Set(fromTokens)] };

  return { label, terms: tokens };
}

/**
 * Whether a dish states that it satisfies this constraint itself.
 *
 * An explicit tag beats a text heuristic. "vegan bacon" tagged vegan is not a
 * vegan violation, and a dish tagged "peanut free" is not disqualified by the
 * word peanut sitting in a warning about cross-contamination. Tags only, never
 * description text, because a description is prose written by a restaurant.
 */
function dishClaimsCompliance(tags: readonly string[], label: string): boolean {
  if (!label) return false;
  for (const tag of tags) {
    const t = normalize(tag);
    if (t === ` ${label} `) return true;
    if (t === ` ${label} free `) return true;
    if (t === ` ${label} friendly `) return true;
  }
  return false;
}

/** The text a term is matched against: name, description and tags together. */
function haystack(candidate: ConstraintCandidate): string {
  const parts = [candidate.name, candidate.description ?? '', ...(candidate.tags ?? [])];
  return normalize(parts.join(' '));
}

/**
 * Whether this rule disqualifies this dish.
 *
 * Whole-word matching with a naive plural, so "fish" does not fire on
 * "fisherman's stew" spelled differently, and "peanut" still fires on
 * "peanuts". Substring matching was the first version and it excluded every
 * dish containing "ham" from a halal filter, including "hamachi".
 */
function ruleExcludes(rule: ExclusionRule, text: string, tags: readonly string[]): boolean {
  if (dishClaimsCompliance(tags, rule.label)) return false;
  for (const term of rule.terms) {
    if (!term) continue;
    if (text.includes(` ${term} `)) return true;
    if (text.includes(` ${term}s `)) return true;
    if (text.includes(` ${term}es `)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

/**
 * Apply already-fetched constraint rows to a candidate list.
 *
 * Guarantees:
 *  - Rows whose consentedAt is null are dropped, and rows for users outside
 *    `userIds` are dropped, before anything else happens.
 *  - Filtering is a set intersection: the result is the candidate set
 *    intersected with the allowed set of every applied constraint, so one
 *    person's constraint can only ever remove a dish, never restore one.
 *  - The returned object has exactly two keys, `candidates` and `appliedCount`,
 *    and is frozen. No constraint value, kind, owner, or removal reason is
 *    reachable from it.
 *  - `appliedCount` is the number of consented rows applied, including rows
 *    that removed nothing.
 *  - Candidate order is preserved and duplicate ids collapse to the first.
 *
 * Exported separately from the async path because the enterprise flow gets its
 * rows from the Merge MCP client rather than from Postgres, and that path must
 * not have to invent a ConstraintSource to reuse the filter.
 */
export function applyConstraintRows<T extends ConstraintCandidate>(
  userIds: readonly string[],
  candidates: readonly T[],
  rows: readonly ConstraintRow[],
): ConstraintFilterResult<T> {
  const subjects = new Set(userIds);

  // Consent first, scope second. Both are re-checked here even though the
  // Supabase source also applies them, because a source is replaceable and this
  // gate is not allowed to be.
  const usable = rows.filter(
    (r) => r.consentedAt !== null && r.consentedAt !== undefined && subjects.has(r.userId),
  );

  const rules = usable.map((r) => exclusionRuleFor(r.value));

  // Deduplicate by id first so a repeated candidate cannot survive as two rows.
  const unique: T[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    unique.push(c);
  }

  // Set intersection, written as one. allowed starts as the whole candidate set
  // and is intersected once per constraint. The loop cannot add an id back.
  let allowed = new Set(unique.map((c) => c.id));
  for (const rule of rules) {
    if (rule.terms.length === 0) continue;
    const permitted = new Set<string>();
    for (const c of unique) {
      if (!allowed.has(c.id)) continue;
      if (!ruleExcludes(rule, haystack(c), c.tags ?? [])) permitted.add(c.id);
    }
    allowed = permitted;
  }

  return sealResult<T>({
    candidates: unique.filter((c) => allowed.has(c.id)),
    // Every consented row in scope counts, whether or not its terms matched.
    appliedCount: usable.length,
  });
}

/**
 * Fetch the constraints for a set of users and apply them to a candidate list.
 *
 * Guarantees: everything applyConstraintRows guarantees, plus the rows are
 * fetched and discarded inside this call. They are never returned, never
 * stored, and never logged, so no caller can hold them. With an empty user set
 * no fetch happens at all.
 */
export async function filterCandidatesForUsers<T extends ConstraintCandidate>(
  userIds: readonly string[],
  candidates: readonly T[],
  source: ConstraintSource = defaultConstraintSource(),
): Promise<ConstraintFilterResult<T>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) {
    return applyConstraintRows<T>(unique, candidates, []);
  }
  const rows = await source.rowsForUsers(unique);
  return applyConstraintRows<T>(unique, candidates, rows);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * A source backed by a fixed list of rows.
 *
 * Guarantees: no network, no database, no credentials. This is what the tests
 * and the seeded demo run against, and it is the reason the filter can be
 * proved correct without Supabase being reachable.
 */
export function inMemoryConstraintSource(rows: readonly ConstraintRow[]): ConstraintSource {
  const snapshot = rows.map((r) => ({ ...r }));
  return {
    async rowsForUsers(userIds: readonly string[]): Promise<readonly ConstraintRow[]> {
      const wanted = new Set(userIds);
      return snapshot.filter((r) => wanted.has(r.userId));
    },
  };
}

/**
 * A source backed by the `constraints` table, read with the service role.
 *
 * Guarantees: selects only the four columns the filter uses, never `id` or
 * `source`, and applies the consent predicate in SQL as well as in the filter.
 * A query error throws with no row detail attached, because an error message is
 * a log line waiting to happen.
 */
export function supabaseConstraintSource(): ConstraintSource {
  return {
    async rowsForUsers(userIds: readonly string[]): Promise<readonly ConstraintRow[]> {
      const client = getServiceClient();
      const { data, error } = await client
        .from('constraints')
        .select('user_id, kind, value, consented_at')
        .in('user_id', [...userIds])
        .not('consented_at', 'is', null);

      if (error) {
        // Deliberately generic. Supabase puts the failing predicate, and
        // therefore sometimes the values, into error.details.
        throw new Error('Constraint lookup failed.');
      }

      return (data ?? []).map((row: Record<string, unknown>) => ({
        userId: String(row.user_id ?? ''),
        kind: String(row.kind ?? ''),
        value: String(row.value ?? ''),
        consentedAt: row.consented_at == null ? null : String(row.consented_at),
      }));
    },
  };
}

/**
 * The source to use when the caller has no opinion.
 *
 * Live when a service-role credential exists, empty otherwise. The empty case
 * is fail-open on filtering, which would be unacceptable against real users and
 * is stated here rather than hidden: with no database there are no users and no
 * constraint rows to honour, so the alternative is a demo that cannot run. The
 * moment SUPABASE_SERVICE_ROLE_KEY appears this switches to the live table with
 * no code change.
 */
export function defaultConstraintSource(): ConstraintSource {
  if (hasServiceRoleCredentials()) return supabaseConstraintSource();
  return inMemoryConstraintSource([]);
}

/**
 * Internals reachable from the test file only. Not part of the module surface:
 * exclusionRuleFor returns strings derived from a constraint value, and the one
 * thing this module promises is that such strings have no public exit.
 */
export const __testing = {
  exclusionRuleFor,
  lexiconLookup,
  ruleExcludes,
  haystack,
  normalize,
  sealResult,
};
