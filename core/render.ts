/**
 * Evidence packet renderer. Track A.
 *
 * EvidencePacket in, two to four sentences of word of mouth out.
 *
 * THE MODEL RENDERS, IT NEVER DECIDES (hard rule 2). Everything the model is
 * allowed to say is already in the packet before the call is made. It cannot
 * query anything, it cannot add a caveat, and it cannot reach for a fact it
 * happens to know about the restaurant. The interesting engineering here is not
 * the prompt, it is the validator underneath it: a prompt is a request, and a
 * request is not an enforcement mechanism. Every rule that matters is checked
 * on the returned text, and text that fails is retried and then refused.
 *
 * WHY REFUSING BEATS RETURNING SOMETHING
 * The failure this product cannot survive is a confident sentence that is not
 * true: an invented dish, a twin that does not exist, a downside quietly
 * dropped. A missing recommendation is a bad moment for one user. A fabricated
 * one is the reason nobody believes the next hundred.
 *
 * DRY RUN. With no ANTHROPIC_API_KEY the renderer produces deterministic
 * template output from the same packet fields and makes zero network calls, so
 * every surface downstream is testable and demoable now. Same pattern as
 * scripts/corpus/extract.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { CONSTANTS, type EvidencePacket, type RenderedRecommendation } from '../contracts/types';
import { anthropicClientOptions, hasModelCredentials } from './anthropic-client';

/** Voice quality matters more than cost here, and rendering volume is low. */
const RENDER_MODEL = 'claude-opus-5';

/** Hard rule 6: under four sentences. Two is the floor, one sentence is a slogan. */
const MAX_SENTENCES = 4;
const MIN_SENTENCES = 2;

/**
 * Chained-clause ceiling. An anti-gaming backstop, not a second sentence limit,
 * and deliberately higher than MAX_SENTENCES.
 *
 * Calibrated by measurement rather than taste, because setting it equal to
 * MAX_SENTENCES rejected correct writing: against the live model, two of three
 * renderings failed here on prose that was fine.
 *
 *   3  the target voice example from the spec
 *   3  live model output that passed everything else
 *   5  live model output on the twin packet, correct but clause-heavy
 *   ---------------------------------------------------------------
 *   6  semicolon chain, every period replaced
 *   6  dash chain
 *   7  "and" splice
 *
 * 5 sits in the gap. Legitimate writing never exceeded it and no abuse case
 * reached it. Re-measure with scripts/corpus/live-voice-check.ts before moving.
 */
const MAX_CLAUSES = 5;

/** One initial attempt plus two repairs. Beyond that the model is not going to get there. */
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Whether the twin channel may be mentioned at all (hard rule 5).
 *
 * Checked here rather than trusted from the packet author, because this is the
 * one rule where a caller's off-by-one becomes a fabricated social proof claim.
 * The twin block is withheld from the prompt entirely when this is false, so
 * the model cannot mention what it was never given.
 */
export function twinChannelAllowed(packet: EvidencePacket): boolean {
  const t = packet.twinSupport;
  if (!t) return false;
  return t.kFloorMet && t.n >= CONSTANTS.K_FLOOR && t.lift > CONSTANTS.LIFT_DELTA;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You write one short recommendation, in the voice of a friend who eats out
constantly and does not oversell.

YOU RENDER A PACKET. YOU DO NOT KNOW ANYTHING ELSE.
Every claim you make must trace to a field you were given. You have no
knowledge of this restaurant, this neighborhood, or this dish beyond the packet.
If a fact is not in the packet, it does not exist. Do not name a dish, a venue,
a street, a chef, a price, or a wait time that is not in the packet.

LEAD WITH THE DISH.
Word of mouth is "get the liang pi", not "check out Hunan Slurp". The venue is
the address of the recommendation. The dish is the recommendation.

ALWAYS INCLUDE A DOWNSIDE.
What to skip, when not to go, who this is wrong for, what will surprise them.
A recommendation with no downside is an advertisement, and people can tell.
When the packet has caveats, at least one of them must appear in the output.

NAME THE DIVERGENCE FROM THE CROWD.
When the packet gives you what the room usually orders, say that this pick is
not that. That contrast is the single most informative sentence you can write.

VOICE. YOU ARE TEXTING A FRIEND, NOT PUBLISHING A REVIEW.
Write the way a person texts. Lowercase "i" always, never capital "I". Start
sentences lowercase unless it is a proper noun. Contractions everywhere: dont,
thats, its, youre, theyre. Short clauses. Trailing "tho", "ngl", "fwiw" are
fine in moderation. Sentence fragments are fine.

Say things like "get the X", "the Y is the move", "skip the Z", "worth it but",
"heads up tho". Never "I recommend", "consider trying", "this establishment
offers", "for your consideration".

Still no exclamation points. No emoji. No "you'll love", no "amazing", no
"must-try", no "incredible", no "delicious". Casual is not the same as
excited: a friend who actually eats out a lot is understated, not hyped. Name
the dish, name the catch, stop.

NO DASHES BETWEEN CLAUSES. No em-dash, no en-dash, no double hyphen. Use a comma
or start a new sentence. A dash is the clearest sign a machine wrote something,
and the whole point of this is that it reads like a person told you. A hyphen
inside a compound word like "char-forward" is fine.

SIMILARITY IS LANGUAGE, NEVER A NUMBER.
Say "people who share your thing about sweetness in savory food". Never say a
match percentage, a similarity score, a reliability rating, or anything that
sounds like a metric about a person. A count of people is fine.

WHEN THE PACKET HAS TWIN SUPPORT, LEAD WITH THE HEARSAY.
This is the whole product, so say it the way a friend actually would:
  "ive heard good things about the mapo from a few people who hate sweetness
   in savory food the way you do"
  "six people i trust for you went for the liang pi over the noodles"
  "the people who eat closest to you keep ordering the tripa, not the pastor"
Attribute to WHO THEY ARE (the cluster descriptor in the packet), never to
their names, never to "my friends". You have not met them, and claiming you
have is the one thing that makes this feel fake. "people who eat like you" and
"people i trust for you" are both honest and both land.

NEVER EXPLAIN THE ALGORITHM.
No vectors, no cosine, no thresholds, no clusters, no model, no "based on your
data". The reader is being told something by a person, not shown a system.

WHEN THERE IS NO TWIN SUPPORT IN THE PACKET.
Do not mention twins, "people like you", "others who share your taste", "six
people who", or any group of similar diners, in any wording at all. Not one
hedged word. Ground the pick in the taste axes instead. If a caveat came from
someone else, state it as a fact about the dish and do not attribute it to
people.

HEDGING.
Confidence low means say so plainly, something like "this is a lead, not a
promise". Confidence high still does not mean enthusiasm.

LENGTH. COUNT THEM BEFORE YOU SEND.
Two to four sentences. FOUR IS A HARD CEILING, not a target.

Texting style makes this harder, not easier: short casual clauses tempt you
into firing off five or six little sentences. Do not. Every fragment ending in
a period counts as one. If you are at four and still have something to say,
cut it or fold it into an existing sentence with a comma. The dish, the reason,
and the catch fit in three.

Output the recommendation text only, with no preamble, no quotes around it, and
no closing question.`;

/** Numbers about places are fine to speak. Numbers about people are not (hard rule 1). */
function priceLine(cents: number | null): string | null {
  if (cents == null) return null;
  return `about $${(cents / 100).toFixed(0)}`;
}

/**
 * The packet as prose for the model.
 *
 * Two fields are deliberately withheld. constraintsAppliedCount never enters a
 * prompt (hard rule 3: constraints leave the system as an integer and nothing
 * else), and twinSupport.lift is a metric that has no spoken form, so giving it
 * to a model that has been told not to speak numbers about people is only a
 * temptation.
 */
export function buildPacketBrief(packet: EvidencePacket): string {
  const lines: string[] = [];

  lines.push(`DISH: ${packet.dish.name}`);
  lines.push(`VENUE: ${packet.dish.venueName}, ${packet.dish.neighborhood}`);
  const price = priceLine(packet.dish.priceCents);
  if (price) lines.push(`PRICE: ${price}`);
  lines.push(`HOW WELL WE READ THIS DISH: ${packet.dish.phiConfidence}`);

  if (packet.userAxes.length > 0) {
    lines.push('');
    lines.push('WHAT DROVE THIS PICK (the reader\'s own taste, in plain words):');
    for (const a of packet.userAxes) {
      const direction = a.value >= 0 ? 'high' : 'low';
      lines.push(`- ${a.label}: they sit ${direction}, around the ${ordinal(a.percentile)} percentile`);
    }
  }

  if (twinChannelAllowed(packet) && packet.twinSupport) {
    lines.push('');
    lines.push(`SIMILAR DINERS: ${packet.twinSupport.n} people, described as: ${packet.twinSupport.clusterDescriptor}`);
    lines.push('You may say how many people. You may not say how similar they are.');
  } else {
    lines.push('');
    lines.push('SIMILAR DINERS: none available. Do not refer to other diners, other');
    lines.push('people, a group, or anyone who shares this reader\'s taste, in any form.');
  }

  if (packet.populationBaseline) {
    lines.push('');
    lines.push(
      `WHAT THE ROOM USUALLY ORDERS: ${packet.populationBaseline.topDishName} ` +
        `(${Math.round(packet.populationBaseline.topDishShare * 100)} percent of orders here)`,
    );
  }

  if (packet.caveats.length > 0) {
    lines.push('');
    lines.push('CAVEATS. At least one of these must appear in your output:');
    for (const c of packet.caveats) {
      lines.push(`- ${c.claim}${c.n > 0 ? ` (reported ${c.n} times)` : ''}`);
    }
  }

  if (packet.expansion?.outsideRegion) {
    lines.push('');
    lines.push(
      `STRETCH: this sits outside what the reader has liked before, ` +
        `${packet.expansion.distance === 'far' ? 'well outside' : 'just outside'} it.`,
    );
  }

  lines.push('');
  lines.push(`CONFIDENCE: ${packet.confidence}`);

  return lines.join('\n');
}

function ordinal(n: number): string {
  const v = Math.round(n);
  const teens = v % 100 >= 11 && v % 100 <= 13;
  const suffix = teens ? 'th' : v % 10 === 1 ? 'st' : v % 10 === 2 ? 'nd' : v % 10 === 3 ? 'rd' : 'th';
  return `${v}${suffix}`;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export type ViolationCode =
  | 'enthusiasm'
  | 'ungrounded_name'
  | 'twin_without_support'
  | 'too_long'
  | 'too_short'
  | 'missing_downside'
  | 'constraint_leak'
  | 'algorithm_leak'
  | 'number_about_people'
  | 'empty';

export interface Violation {
  code: ViolationCode;
  /** Human-readable, and fed back to the model verbatim on retry. */
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

/**
 * Enthusiasm markers (hard rule 6).
 *
 * A real list, not a token gesture. These are the words that turn word of mouth
 * into copywriting, and once one lands the whole message reads as an ad.
 * Applied to the output text even when a caveat in the packet happens to
 * contain one, because the rule is about what we say, not what we were told.
 */
const ENTHUSIASM_PATTERNS: RegExp[] = [
  // Every exclamation mark a keyboard or a model can produce, not just U+0021.
  // A fullwidth "！" reads as enthusiasm to a human and as an ordinary character
  // to /!/, which is exactly the kind of gap a keyword list is bad at.
  /[!！︕﹗‼⁉ǃ՜߹]/,
  /\byou'?ll love\b/i,
  /\byou will love\b/i,
  /\byou'?re going to love\b/i,
  /\bamazing\b/i,
  /\bmust[- ]?try\b/i,
  /\bmust[- ]?visit\b/i,
  /\bmust[- ]?order\b/i,
  /\bincredible\b/i,
  /\bdelicious\b/i,
  /\bdivine\b/i,
  /\bheavenly\b/i,
  /\bphenomenal\b/i,
  /\bspectacular\b/i,
  /\bfantastic\b/i,
  /\bwonderful\b/i,
  /\bawesome\b/i,
  /\bsuperb\b/i,
  /\bexquisite\b/i,
  /\bsublime\b/i,
  /\bmind[- ]?blowing\b/i,
  /\blife[- ]?changing\b/i,
  /\bto die for\b/i,
  /\bunforgettable\b/i,
  /\bhidden gem\b/i,
  /\bgame[- ]?changer\b/i,
  /\bepic\b/i,
  /\blegendary\b/i,
  /\bobsessed\b/i,
  /\bcraving\b/i,
  /\bbest .{0,20}\bever\b/i,
  /\bdon'?t miss\b/i,
  /\bdo not miss\b/i,
  /\bcan'?t go wrong\b/i,
  /\bhighly recommend\b/i,
  /\bworth every penny\b/i,
  /\btrust me\b/i,
  /\byum\b/i,
  /\byummy\b/i,

  // Second wave: enthusiasm that carries no banned adjective. A model told to
  // avoid "amazing" does not go flat, it goes to "a genuinely special plate"
  // and "you will not regret it", which are the same sales pitch with the
  // fingerprints wiped off. "the special" stays legal, because that is a menu
  // item rather than a claim.
  /\b(?:a|an|one|so|very|quite|pretty|truly|genuinely|really|something|somewhat)\s+(?:\w+\s+)?special\b/i,
  /\byou\s+(?:will\s+not|won'?t|wont)\s+regret\b/i,
  /\bno regrets\b/i,
  /\bunmissable\b/i,
  /\bnot to be missed\b/i,
  /\byou (?:have|need|gotta|got) to try\b/i,
  /\byou owe it to yourself\b/i,
  /\bdo yourself a favou?r\b/i,
  /\btreat yourself\b/i,
  /\bdon'?t sleep on\b/i,
  /\bone of the best\b/i,
  /\bworth the (?:trip|wait|hype|money|detour|line|queue)\b/i,
  /\bgo out of your way\b/i,
  /\brun,?\s+(?:don'?t|do not)\s+walk\b/i,
  /\b(?:ridiculously|absurdly|stupidly|insanely|wildly|unreasonably|impossibly|crazy)\s+(?:good|tasty|great)\b/i,
  /\bso good\b/i,
  /\bblow(?:n|s)?\s+(?:you\s+)?away\b/i,
  /\bnext[- ]?level\b/i,
  /\bchef'?s kiss\b/i,
  /\bthe real deal\b/i,
  /\bcult (?:favou?rite|following|classic)\b/i,
  /\bworld[- ]?class\b/i,
  /\btop[- ]?notch\b/i,
  /\bfirst[- ]?rate\b/i,
  /\bstandout\b/i,
  /\bshowstopper\b/i,
  /\bknockout\b/i,
  /\bstunning\b/i,
  /\bstellar\b/i,
  /\bsensational\b/i,
  /\bglorious\b/i,
  /\btranscendent\b/i,
  /\brevelation\b/i,
  /\bflawless\b/i,
  /\bimmaculate\b/i,
  /\bperfect(?:ion|ly)?\b/i,
  /\baddictive\b/i,
  /\bcrave?able\b/i,
  /\bmouth[- ]?watering\b/i,
  /\bdecadent\b/i,
  /\bluscious\b/i,
  /\bsucculent\b/i,
  /\bdrool/i,
  /\bheaven\b/i,
  /\bnirvana\b/i,
  /\bdreamy\b/i,
  /\biconic\b/i,
  /\bmagical\b/i,
  /\bkiller\b/i,
  /\bbanger\b/i,
  /\bunreal\b/i,
  /\belite\b/i,
  /\bgorgeous\b/i,
  /\bbeautiful\b/i,
  /\blovely\b/i,
  /\bterrific\b/i,
  /\bbrilliant\b/i,
  /\bmagnificent\b/i,
  /\boutstanding\b/i,
  /\bexcellent\b/i,
  /\bmarvell?ous\b/i,
  /\bsplendid\b/i,
  /\bfabulous\b/i,
  /\bglowing\b/i,
  /\b\d{1,2}\s*\/\s*10\b/,
  /\b(?:five|5)[- ]stars?\b/i,
  /\bstar of the (?:menu|show)\b/i,
  /\bit slaps\b/i,
  /\bgoes hard\b/i,
  /\bis fire\b/i,
  /\bbussin\b/i,
  // Emoticons are emoji typed on a keyboard, and the rule is about the tone
  // they set rather than the code points they use.
  /[:;=]-?[)(\][dDpP]/,
  /<3/,
];

/**
 * Emoji, by code point range rather than a unicode property escape, so this
 * compiles at the repo's ES2017 target. Deliberately does not include CJK
 * blocks: a dish name written in its own script is not an emoji.
 *
 * The ranges below the astral plane matter more than they look. Miscellaneous
 * Technical (⏳, ⌛, ⏰) and Geometric Shapes (▶, ◀) are emoji on every phone
 * that will ever render this message and sit outside the obvious "☀ to ➿"
 * block, so a list that stops at U+2600 catches the party popper and waves the
 * hourglass through. Quotes, dashes and the ellipsis character are deliberately
 * left out: they are punctuation, not decoration.
 */
const EMOJI_PATTERN = new RegExp(
  '[' +
    '\\u2190-\\u21FF' + // arrows
    '\\u2300-\\u23FF' + // misc technical: hourglass, alarm clock, keyboard
    '\\u2460-\\u24FF' + // enclosed alphanumerics
    '\\u25A0-\\u27BF' + // geometric shapes, misc symbols, dingbats
    '\\u2900-\\u297F' + // supplemental arrows
    '\\u2B00-\\u2BFF' + // stars, arrows, shapes
    '\\u3030\\u303D\\u3297\\u3299' + // wavy dash, part alternation, CJK emoji marks
    '\\u20E3\\uFE0F' + // combining keycap, variation selector 16
    ']' +
    '|[\\u{1F000}-\\u{1FBFF}]', // everything in the astral emoji planes
  'u',
);

/**
 * Twin language, as a CONCEPT rather than a word.
 *
 * The literal word "twin" is the easy case and the one a model almost never
 * produces. What it actually produces when told to avoid twins is "a few people
 * with a similar palate", which is the same claim wearing a hat. Every pattern
 * here is a claim that some group of other diners exists and resembles the
 * reader.
 */
const TWIN_LANGUAGE_PATTERNS: RegExp[] = [
  /\btwins?\b/i,
  /\bpeople (?:who|like|that|with)\b/i,
  /\bothers who\b/i,
  /\bother (?:people|diners|regulars)\b/i,
  /\bdiners who\b/i,
  /\bfolks who\b/i,
  /\beveryone who\b/i,
  /\bsomeone (?:with|who shares)\b/i,
  /\blike you\b/i,
  /\bshares? your\b/i,
  /\bshare your\b/i,
  /\byour kind of\b/i,
  /\bsimilar (?:taste|palate|preferences|diners)\b/i,
  /\bsame (?:taste|palate)\b/i,
  /\b(?:who|that) share\b/i,
  // Counted groups only. "most people find it cold" is a claim about the world,
  // and it is checked elsewhere for grounding. "six people" is a claim that a
  // specific set of similar diners exists, which is the thing being forbidden.
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|several)\s+(?:of them|people|others|diners|regulars|reviewers|users)\b/i,
  /\bof them (?:said|say|told|mentioned|noted|thought|found)\b/i,
  /\bpeople (?:said|say|told|mentioned|picked|order|ordered|chose)\b/i,
  /\bcrowd like\b/i,
  /\byour cluster\b/i,
];

/**
 * The same rule again, as a shape rather than a phrase list.
 *
 * A phrase list loses this fight. "a handful of regulars", "the ones with your
 * palate", "palates like yours" and "people whose ratings line up with yours"
 * are all the forbidden claim, and none of them contain a phrase from the list
 * above. What they share is structure: a noun that denotes a group of humans,
 * standing within a few words of something that ties that group to the reader.
 * Either half alone is innocent. "most people find it cold" is a claim about
 * the world, and "if you want something hot" is addressed to the reader. It is
 * the pairing that fabricates a cohort, so the pairing is what is detected.
 */
const GROUP_NOUN =
  '(?:people|persons|person|folks|diners|diner|eaters|eater|regulars|regular|others|ones|' +
  'customers|patrons|guests|reviewers|users|locals|crowd|group|handful|bunch|dozen|' +
  'couple|few|several|everybody|everyone|somebody|someone|anybody|anyone|nobody|' +
  'palates|tastes|table|tables)';

/** Anything that ties a group to this specific reader. */
const READER_LINK =
  '(?:like\\s+you\\b|like\\s+yours\\b|with\\s+your\\b|with\\s+the\\s+same\\b|' +
  'who\\s+share|that\\s+share|share\\s+your|whose\\b|who\\s+eat|who\\s+order|' +
  'who\\s+rate|who\\s+go\\b|who\\s+avoid|for\\s+you\\b|your\\s+palate|your\\s+taste|' +
  'your\\s+thing|your\\s+kind|your\\s+corner|your\\s+aversion|your\\s+side|' +
  'the\\s+same\\s+(?:way|thing|taste|palate|aversion)|as\\s+you\\s+do|' +
  'the\\s+way\\s+you\\b|i\\s+trust|we\\s+trust|you\\s+trust|you\\s+would\\s+trust)';

const TWIN_CONCEPT_PATTERNS: RegExp[] = [
  // group noun, then a tie to the reader within four words
  new RegExp(`\\b${GROUP_NOUN}\\b(?:\\s+\\S+){0,4}?\\s+${READER_LINK}`, 'i'),
  // the same claim inverted: "your kind of eaters", "the same aversion crowd"
  new RegExp(`${READER_LINK}(?:\\s+\\S+){0,3}?\\s+\\b${GROUP_NOUN}\\b`, 'i'),
  // a counted cohort with no tie stated, which the reader supplies for free
  new RegExp(
    '\\b(?:a|the|half\\s+a|another)?\\s*' +
      '(?:few|handful|bunch|couple|dozen|number|group|cluster|circle|pocket|crew|set|pair|trio)\\s+' +
      '(?:of\\s+(?:the\\s+|these\\s+|those\\s+)?)?' +
      '(?:them|us|people|persons|others|diners|eaters|regulars|folks|customers|patrons|' +
      'guests|locals|reviewers|users|palates|tastes)\\b',
    'i',
  ),
];

/** Article 9 vocabulary. None of it is in the packet, so none of it may be in the output. */
const CONSTRAINT_TERMS: RegExp[] = [
  /\bhalal\b/i,
  /\bkosher\b/i,
  /\bvegan\b/i,
  /\bvegetarian\b/i,
  /\bgluten[- ]?free\b/i,
  /\bceliac\b/i,
  /\bcoeliac\b/i,
  /\ballerg(?:y|ies|en|ens|ic)\b/i,
  /\blactose\b/i,
  /\bdairy[- ]?free\b/i,
  /\bnut[- ]?free\b/i,
  /\bdietary (?:restriction|requirement|need)/i,
  /\bpescatarian\b/i,
];

/** Machinery vocabulary. The reader is being told something, not shown a system. */
const ALGORITHM_TERMS: RegExp[] = [
  /\balgorithm\b/i,
  /\bcosine\b/i,
  /\bvector\b/i,
  /\bthreshold\b/i,
  /\bembedding\b/i,
  /\bcluster(?:ed|ing)?\b/i,
  /\bpercentile\b/i,
  /\bconfidence (?:score|interval)\b/i,
  /\bdata (?:says|shows|suggests)\b/i,
  /\bour model\b/i,
  /\bthe model\b/i,
  /\bpredict(?:s|ed|ion|ive)?\b/i,
  // "correlate" bare is the form a model reaches for when it is explaining
  // itself in plain words, and it was the one form the old list did not have.
  /\bcorrelat\w*/i,
  /\bsimilarity\b/i,
  /\bmachine learning\b/i,
  /\btraining data\b/i,
  /\brecommendation engine\b/i,
  /\bnearest\b/i,
  /\b(?:your|our|the) (?:taste )?profile\b/i,
  /\bbased on (?:your|what you)\b/i,
  /\byour (?:data|ratings|history|answers|duels|inputs)\b/i,
  /\bwe (?:scored|score|ranked|rank|computed|compute|calculated|matched|match|modelled|modeled)\b/i,
  /\b(?:the|our) system\b/i,
  /\bscored?\s+(?:it|this|you|against|higher|highest)\b/i,
  /\brank(?:ed|s)?\s+(?:it|this|first|highest|top)\b/i,
];

/**
 * Rule 1 is about metrics attached to humans, not about counting people. "Six
 * people picked it" is evidence. "94% match" is a number about a person, and it
 * is also a lie about precision we do not have.
 */
const PEOPLE_METRIC_PATTERNS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*%\s*(?:match|similar|compatib|overlap)/i,
  /\b(?:match|similarity|compatibility|reliability|affinity)\s*(?:score|rating|percentage|percent|level)\b/i,
  /\b\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:match|similarity)\b/i,
  /\byou (?:are|'re) a \d+/i,
];

/**
 * NO LONGER USED by the proper-noun check, and kept only as a record of an
 * approach that failed.
 *
 * This was an allowlist of common sentence-initial words, so that a capitalized
 * ordinary word would not be mistaken for a venue. Against the live model it
 * rejected "Fair warning" as a hallucinated name, because no hand-written list
 * of ninety words can stand in for English. See findUngroundedProperNouns for
 * what replaced it.
 *
 * Left in place because the dish-slot check below still consults nothing like
 * it, and re-adding a word list is a tempting wrong turn worth labelling.
 */
const COMMON_STARTERS = new Set([
  'a', 'an', 'and', 'ask', 'at', 'avoid', 'be', 'both', 'bring', 'but', 'come',
  'confidence', 'do', 'dont', 'either', 'eight', 'eleven', 'everyone', 'expect',
  'few', 'five', 'for', 'four', 'get', 'go', 'half', 'he', 'her', 'his', 'how',
  'i', 'if', 'in', 'is', 'it', 'its', 'keep', 'know', 'less', 'like', 'look',
  'many', 'most', 'nine', 'no', 'nobody', 'none', 'not', 'note', 'on', 'once',
  'one', 'only', 'or', 'order', 'people', 'plan', 'seven', 'she', 'six', 'skip',
  'so', 'some', 'someone', 'still', 'take', 'ten', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'three', 'to',
  'treat', 'twelve', 'two', 'we', 'what', 'when', 'where', 'which', 'while',
  'who', 'why', 'worth', 'you', 'your',
]);

/**
 * Words that can follow "get the" or "skip the" without naming a dish. Without
 * this the validator flags "skip the wait" as a hallucinated dish. Stopwords
 * count too, which is what keeps "share your thing about acidity" from reading
 * as an order for a dish called "your thing".
 */
const NON_DISH_HEADS = new Set([
  'anything', 'bar', 'both', 'check', 'counter', 'crowd', 'dinner', 'early',
  'everything', 'food', 'half', 'here', 'hype', 'it', 'kitchen', 'late', 'line',
  'lot', 'lunch', 'menu', 'most', 'night', 'nothing', 'now', 'one', 'order',
  'other', 'others', 'place', 'portion', 'rest', 'room', 'same', 'seat',
  'something', 'special', 'spot', 'table', 'that', 'them', 'there', 'thing',
  'this', 'time', 'tonight', 'usual', 'wait', 'whole',
]);

/**
 * Verbs that introduce a dish in this voice. The slot where a hallucination lands.
 *
 * The word body has to include the accented range. With a bare \w, "get the
 * liàng pi" captures only "li", which is a prefix of the real dish, so the
 * check grounds it and the altered spelling walks through. One diacritic
 * should not be the difference between a checked name and an unchecked one.
 */
const ORDER_CUE = /\b(?:get|order|orders|ordered|ordering|ask for|go for|skip|split|share|try|start with|stick with|pick|picked|choose|chose)\s+(?:the\s+|a\s+|an\s+|their\s+|its\s+)?((?:[A-Za-zÀ-ɏ][A-Za-z0-9À-ɏ_'’-]*)(?:\s+[A-Za-zÀ-ɏ][A-Za-z0-9À-ɏ_'’-]*){0,3})/gi;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do',
  'for', 'from', 'had', 'has', 'have', 'how', 'in', 'is', 'it', 'its', 'not',
  'of', 'on', 'or', 'so', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'they', 'this', 'to', 'too', 'was', 'were', 'what', 'when', 'which',
  'who', 'will', 'with', 'you', 'your',
]);

/**
 * Words that may follow a real dish name without extending it.
 *
 * "get the liang pi over the noodles" continues into a comparison. "get the
 * liang pi noodle soup" continues into a different dish. The difference is
 * whether the next word is grammar or food, so grammar is enumerated and
 * everything else is treated as food.
 */
const CONTINUATION_WORDS = new Set([
  ...STOPWORDS,
  'about', 'after', 'again', 'against', 'all', 'also', 'although', 'always',
  'anyway', 'around', 'because', 'before', 'behind', 'below', 'beside',
  'besides', 'between', 'both', 'down', 'during', 'each', 'either', 'else',
  'even', 'ever', 'every', 'except', 'first', 'here', 'if', 'instead', 'into',
  'just', 'last', 'later', 'like', 'me', 'more', 'most', 'much', 'near',
  'neither', 'never', 'next', 'nor', 'now', 'off', 'once', 'one', 'only',
  'onto', 'other', 'others', 'out', 'over', 'per', 'plus', 'rather', 'right',
  'second', 'since', 'still', 'today', 'tonight', 'tomorrow', 'twice', 'under',
  'unless', 'until', 'up', 'us', 'versus', 'vs', 'we', 'while', 'why',
  'without', 'yet',
]);

/**
 * A downside is a thing said, not a word matched.
 *
 * Matching caveat vocabulary alone is not enough, because the caveat's own
 * words survive a rewrite that inverts them: "served cold, unexpected" is
 * satisfied by "the coldest, cleanest thing on the menu", which is an
 * advertisement that happens to contain the word cold. Requiring one signal
 * that something is being warned about does not make the check semantic, but it
 * does mean the sentence has to at least be shaped like a warning.
 */
const DOWNSIDE_MARKERS: RegExp[] = [
  /\bskip\b/i, /\bavoid\b/i, /\bnot\b/i, /\bno\b/i, /\bnever\b/i, /\bnobody\b/i,
  /\bbut\b/i, /\bthough\b/i, /\balthough\b/i, /\bunless\b/i, /\bhowever\b/i,
  /\bonly if\b/i, /\bif you want\b/i, /\bwrong for\b/i, /\bworth knowing\b/i,
  /\bwarn/i, /\bheads up\b/i, /\bfair warning\b/i, /\bbeware\b/i, /\bmind that\b/i,
  /expect/i, /\bsurpris/i, /\bdownside\b/i, /\bdrawback\b/i, /\btrade[- ]?off\b/i,
  /\bcatch\b/i, /\bproblem\b/i, /\bcomplain/i, /\bdisappoint/i, /\bflag/i,
  /\bthin\b/i, /\bwait\b/i, /\bloud\b/i, /\bcramped\b/i, /\bmiss\b/i,
  /\brather than\b/i, /\bbe ready\b/i, /\bcash only\b/i,
];

/**
 * Unicode variants folded to their plain ASCII form, case preserved.
 *
 * Every pattern in this file is written with a straight apostrophe and a plain
 * hyphen, so a smart apostrophe or a non-breaking hyphen is a free bypass:
 * "you’ll love it" and "must‑try" are invisible to /you'?ll love/ and
 * /must[- ]?try/. Folding first is cheaper and more complete than doubling
 * every pattern. Zero-width characters are removed outright, since their only
 * use in generated copy is to break a word in half without looking like it.
 */
const SMART_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u02BC\u00B4\u0060]/g;
const SMART_HYPHENS = /[\u2010-\u2015\u2043\u2212\uFE58\uFE63\uFF0D]/g;
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const INVISIBLES = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

function fold(text: string): string {
  return text
    .replace(SMART_QUOTES, "'")
    .replace(SMART_HYPHENS, '-')
    .replace(ODD_SPACES, ' ')
    .replace(INVISIBLES, '');
}

function normalize(text: string): string {
  return fold(text).toLowerCase();
}

function words(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9'À-ɏ]+/)
    .filter(Boolean);
}

/**
 * Sentence split without lookbehind, which the ES2017 target does not allow.
 *
 * A decimal point is not a full stop. Without this, "$14.00" reads as two
 * sentences, which is not a cosmetic miscount: it hands a one-line slogan a
 * free pass on the two-sentence floor.
 */
const DECIMAL_DOT = '․'; // ONE DOT LEADER, stands in for a decimal point

export function splitSentences(text: string): string[] {
  const guarded = text.replace(/(\d)\.(\d)/g, `$1${DECIMAL_DOT}$2`);
  const parts = guarded.match(/[^.?!]+[.?!]*/g) ?? [];
  return parts
    .map((s) => s.split(DECIMAL_DOT).join('.').trim())
    .filter((s) => s.length > 0);
}

/**
 * Sentences, plus the separators a model uses to keep writing after one.
 *
 * Hard rule 6 caps length at four sentences, and a sentence is a unit of
 * reading, not a unit of punctuation. A semicolon chain and a run of "and"
 * clauses produce a paragraph that the period counter scores as two. The rule
 * being defended is "short enough to read in a message thread", so the count
 * has to be of clauses.
 */
function countClauses(foldedText: string): number {
  let count = 0;
  for (const s of splitSentences(foldedText)) {
    count += 1;
    count += (s.match(/;/g) ?? []).length;
    count += (s.match(/\s-{1,2}\s/g) ?? []).length;
    count += (s.match(/,\s+(?:and|but|plus|then)\s/gi) ?? []).length;
  }
  return count;
}

/** Every name the output is allowed to speak. Nothing else is a name. */
function allowedNames(packet: EvidencePacket): string[] {
  const names = [packet.dish.name, packet.dish.venueName, packet.dish.neighborhood];
  if (packet.populationBaseline) names.push(packet.populationBaseline.topDishName);
  return names.filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function allowedWordSet(packet: EvidencePacket): Set<string> {
  const set = new Set<string>();
  for (const name of allowedNames(packet)) for (const w of words(name)) set.add(w);
  return set;
}

/**
 * Capitalized runs that name something the packet never mentioned.
 *
 * Catches invented venues, which is the most damaging hallucination because it
 * sends someone to a door that is not there.
 */
function findUngroundedProperNouns(text: string, packet: EvidencePacket): string[] {
  const allowed = allowedNames(packet).map(normalize);
  const allowedWords = allowedWordSet(packet);
  const found: string[] = [];

  for (const sentence of splitSentences(text)) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    let run: string[] = [];
    let runStart = -1;

    const flush = (): void => {
      if (run.length === 0) return;
      const phrase = run.join(' ');
      const norm = normalize(phrase.replace(/[^A-Za-z0-9'’ À-ɏ]/g, ''));
      const isSentenceStart = runStart === 0;
      const everyWordKnown = words(phrase).every((w) => allowedWords.has(w));
      const inAllowedName = allowed.some((n) => n.includes(norm));
      // A SINGLE capitalized word at the start of a sentence is not evidence of
      // anything: it is capitalized because a sentence started, not because it
      // names a place. This was an allowlist of about ninety lowercase words
      // trying to stand in for all of English, and against the live model it
      // rejected "Fair warning" as a hallucinated venue. "Worth", "Careful",
      // "Honestly" and every other ordinary adjective would have failed the
      // same way.
      //
      // Dropping it costs one narrow detection: a one-word invented venue used
      // only ever at a sentence start. Three mechanisms still cover invented
      // names, and none of them depend on an English word list: multi-word
      // capitalized runs (stricter, below), any capitalized word appearing
      // MID-sentence, and findUngroundedDishes, which works on grammar and so
      // catches lowercase dish names too.
      const commonStart = isSentenceStart && run.length === 1;
      // A multi-word capitalized run is a name, and a name has to appear in the
      // packet as that name. "Every word came from somewhere in the packet" is
      // not enough for two words or more, because the packet's own vocabulary
      // is exactly what a model recombines into "Lower East Noodles" when it
      // wants a second venue and has no second venue.
      const known = run.length > 1 ? inAllowedName : everyWordKnown || inAllowedName;
      if (!known && !commonStart) found.push(phrase);
      run = [];
      runStart = -1;
    };

    tokens.forEach((raw, i) => {
      const bare = raw.replace(/^[^A-Za-zÀ-ɏ]+|[^A-Za-z0-9'’À-ɏ]+$/g, '');
      const capitalized = /^[A-ZÀ-Þ][A-Za-z'’À-ɏ-]*$/.test(bare);
      if (capitalized) {
        if (run.length === 0) runStart = i;
        run.push(bare);
        // A run cannot cross a comma or other punctuation: "Hunan Slurp, get"
        // is one name followed by a verb, not a three word name.
        if (/[,;:.!?]$/.test(raw)) flush();
      } else {
        flush();
      }
    });
    flush();
  }

  return found;
}

/**
 * Dish names in the ordering slot that the packet never provided.
 *
 * Dish names are frequently lowercase ("liang pi"), so capitalization alone
 * cannot find them. What can find them is the grammar: this voice names a dish
 * right after an ordering verb, so that is where an invented dish appears.
 */
function findUngroundedDishes(text: string, packet: EvidencePacket): string[] {
  const allowed = allowedNames(packet).map(normalize);
  const allowedWords = allowedWordSet(packet);
  const found: string[] = [];
  const source = normalize(text);

  ORDER_CUE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ORDER_CUE.exec(source)) !== null) {
    const phraseWords = words(m[1]);
    if (phraseWords.length === 0) continue;
    if (NON_DISH_HEADS.has(phraseWords[0]) || STOPWORDS.has(phraseWords[0])) continue;

    // Anchored prefixes only. Accepting any sub-phrase would let "dan dan
    // noodles" pass on the strength of the packet containing "noodles".
    // The LONGEST grounded prefix, not the first: a real name has to be
    // consumed whole before anything after it can be judged.
    let longest = 0;
    for (let n = 1; n <= phraseWords.length; n++) {
      const candidate = phraseWords.slice(0, n).join(' ');
      if (allowed.some((name) => name.includes(candidate))) longest = n;
    }

    if (longest === 0) {
      found.push(phraseWords.join(' '));
      continue;
    }

    // A grounded prefix is not a licence for whatever follows it. "get the
    // liang pi" is the packet; "get the liang pi noodle soup" is a different
    // dish wearing the packet's first two words, and it was the single easiest
    // hallucination to smuggle past a prefix check. Words after the real name
    // are only allowed if they are grammar ("over the noodles") or vocabulary
    // the packet already owns.
    const tail = phraseWords.slice(longest);
    const invented = tail.filter((w) => !CONTINUATION_WORDS.has(w) && !allowedWords.has(w));
    if (invented.length > 0) found.push(phraseWords.join(' '));
  }

  return found;
}

/**
 * A cohort defined by the reader's own taste axis, with the reader left implicit.
 *
 * "The sweetness-averse crowd here orders it" never says you, us, or similar,
 * so no phrase pattern fires. It is still a fabricated twin: the only reason
 * that group is worth mentioning is that the reader belongs to it, and the
 * packet did not say the group exists. A group noun standing next to the
 * reader's own axis vocabulary is that claim, so proximity is what is measured.
 * Axis language on its own stays legal, which is what the packet is for.
 */
function findAxisCohort(text: string, packet: EvidencePacket): string | null {
  const axisWords = new Set<string>();
  for (const a of packet.userAxes) {
    for (const w of words(a.label)) if (w.length >= 4 && !STOPWORDS.has(w)) axisWords.add(w);
  }
  if (axisWords.size === 0) return null;

  const isGroup = new RegExp(`^${GROUP_NOUN}$`, 'i');
  for (const sentence of splitSentences(text)) {
    const toks = words(sentence);
    for (let i = 0; i < toks.length; i++) {
      if (!isGroup.test(toks[i])) continue;
      for (let j = Math.max(0, i - 4); j <= Math.min(toks.length - 1, i + 4); j++) {
        if (axisWords.has(toks[j])) {
          return toks.slice(Math.min(i, j), Math.max(i, j) + 1).join(' ');
        }
      }
    }
  }
  return null;
}

/**
 * Dollar amounts the packet never contained.
 *
 * A price is the one hallucination a reader acts on before they can check it,
 * and it costs nothing to verify: the packet either has the number or it does
 * not. Amounts written into a caveat are the packet's own words and stay legal.
 */
function findUngroundedAmounts(text: string, packet: EvidencePacket): string[] {
  const spoken = text.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (spoken.length === 0) return [];

  const bare = (s: string): string => s.replace(/[$\s,]/g, '').replace(/\.0+$/, '');
  const allowed = new Set<string>();
  if (packet.dish.priceCents != null) {
    allowed.add(bare(String(packet.dish.priceCents / 100)));
    allowed.add(bare((packet.dish.priceCents / 100).toFixed(0)));
    allowed.add(bare((packet.dish.priceCents / 100).toFixed(2)));
  }
  const packetProse = [
    ...packet.caveats.map((c) => c.claim),
    packet.twinSupport?.clusterDescriptor ?? '',
    packet.populationBaseline?.topDishName ?? '',
  ].join(' ');
  for (const a of packetProse.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? []) allowed.add(bare(a));

  return spoken.filter((s) => !allowed.has(bare(s)));
}

/**
 * Whether any caveat actually made it into the output.
 *
 * Prefix matching on content words so "served cold" is satisfied by "colder
 * than they expected". A caveat that survives only as a vague "some people had
 * notes" does not count, and should not.
 */
function mentionsAnyCaveat(text: string, packet: EvidencePacket): boolean {
  const outputWords = words(text);
  return packet.caveats.some((c) => {
    const claimWords = words(c.claim).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    if (claimWords.length === 0) return true;
    // Prefix match in either direction, but only between words long enough for a
    // shared prefix to mean something. Without the length floor, "a" in the
    // output would satisfy a caveat about anything starting with an a.
    return claimWords.some((cw) =>
      outputWords.some(
        (ow) => ow === cw || ow.startsWith(cw) || (ow.length >= 4 && cw.startsWith(ow)),
      ),
    );
  });
}

function matchFirst(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

/**
 * Check rendered text against every hard rule that can be checked mechanically.
 *
 * Guarantees: a text that returns ok = true contains no enthusiasm marker, no
 * name absent from the packet, no reference to similar diners unless the twin
 * gate is open, no constraint or algorithm vocabulary, no metric about a person,
 * between two and four sentences, and at least one packet caveat when the packet
 * has any. Exported and pure so it can be tested and reused with no API key.
 */
export function validateRendering(text: string, packet: EvidencePacket): ValidationResult {
  const violations: Violation[] = [];
  const trimmed = text.trim();
  // Every text check runs against the folded form, so a smart apostrophe or a
  // non-breaking hyphen cannot walk a banned phrase past a pattern that was
  // written in ASCII. The emoji and proper-noun checks keep the raw text: one
  // needs the characters as sent, the other needs the capitalization.
  const folded = fold(trimmed);
  const flat = normalize(trimmed);

  if (trimmed.length === 0) {
    return { ok: false, violations: [{ code: 'empty', detail: 'Empty output.' }] };
  }

  // Every enthusiasm marker is reported, not just the first. A repair prompt that
  // names one of three markers gets back a line with the other two still in it.
  for (const p of ENTHUSIASM_PATTERNS) {
    const m = folded.match(p);
    if (m) {
      violations.push({
        code: 'enthusiasm',
        detail: `Enthusiasm marker "${m[0].trim()}". Remove it, do not soften it.`,
      });
    }
  }
  if (EMOJI_PATTERN.test(trimmed)) {
    violations.push({ code: 'enthusiasm', detail: 'Contains an emoji. No emoji, ever.' });
  }

  // Em-dashes and en-dashes between clauses. Not an enthusiasm marker, but the
  // single most recognizable tell that a machine wrote something, and this
  // product's whole claim is that a person told you. Live renderings produced
  // them steadily until the prompt forbade it, so it is checked rather than
  // merely requested. A hyphen in "char-forward" is fine and is not matched.
  const dash = trimmed.match(/[–—]|\s-{2,}\s/);
  if (dash) {
    violations.push({
      code: 'enthusiasm',
      detail: `Contains "${dash[0].trim()}". Use a comma or a period. A dash reads as machine-written.`,
    });
  }

  const sentences = splitSentences(trimmed);
  const clauses = countClauses(folded);
  if (sentences.length > MAX_SENTENCES) {
    violations.push({
      code: 'too_long',
      detail: `${sentences.length} sentences. Maximum is ${MAX_SENTENCES}.`,
    });
  } else if (clauses > MAX_CLAUSES) {
    // Anti-gaming, not a second sentence limit. A semicolon or a run of "and"
    // clauses does not make a paragraph shorter, it only makes the periods
    // harder to find, so one sentence with ten chained clauses must still fail.
    //
    // The allowance is deliberately HIGHER than MAX_SENTENCES. Set equal, this
    // rejected ordinary prose: the target voice itself chains "which is not what
    // the room does here, the room orders noodles" inside one sentence, and
    // against the live model two of three renderings failed here on writing that
    // was correct. A validator that refuses the spec's own exemplar is broken.
    violations.push({
      code: 'too_long',
      detail:
        `${clauses} chained clauses across ${sentences.length} sentences. Maximum is ` +
        `${MAX_CLAUSES} clauses and ${MAX_SENTENCES} sentences. Break it up or cut a clause.`,
    });
  }
  if (sentences.length < MIN_SENTENCES) {
    violations.push({
      code: 'too_short',
      detail: `${sentences.length} sentence. Minimum is ${MIN_SENTENCES}, one line is a slogan.`,
    });
  }

  const properNouns = findUngroundedProperNouns(trimmed, packet);
  const dishes = findUngroundedDishes(folded, packet);
  const amounts = findUngroundedAmounts(folded, packet);
  for (const name of [...properNouns, ...dishes]) {
    violations.push({
      code: 'ungrounded_name',
      detail: `"${name}" is not in the packet. Only the dish, the venue, the neighborhood, and what the room orders exist.`,
    });
  }
  for (const amount of amounts) {
    violations.push({
      code: 'ungrounded_name',
      detail: `"${amount}" is a price the packet never gave you. Do not put a number on something you were not told.`,
    });
  }

  if (!twinChannelAllowed(packet)) {
    const twinish =
      matchFirst(folded, TWIN_LANGUAGE_PATTERNS) ??
      matchFirst(folded, TWIN_CONCEPT_PATTERNS) ??
      findAxisCohort(folded, packet);
    if (twinish) {
      violations.push({
        code: 'twin_without_support',
        detail: `"${twinish.trim()}" refers to other diners, and this packet has no twin support. Remove every trace of a group of similar people.`,
      });
    }
  }

  if (packet.caveats.length > 0) {
    if (!mentionsAnyCaveat(trimmed, packet)) {
      violations.push({
        code: 'missing_downside',
        detail: `No caveat made it into the output. Use one of: ${packet.caveats.map((c) => c.claim).join('; ')}`,
      });
    } else if (!DOWNSIDE_MARKERS.some((p) => p.test(folded))) {
      // The caveat's words are present but nothing in the line reads as a
      // warning, which is how a caveat gets repeated as a selling point.
      violations.push({
        code: 'missing_downside',
        detail:
          `The caveat's words appear but nothing in the line reads as a downside. State it as ` +
          `something that could go wrong: ${packet.caveats.map((c) => c.claim).join('; ')}`,
      });
    }
  }

  const constraint = matchFirst(folded, CONSTRAINT_TERMS);
  if (constraint) {
    violations.push({
      code: 'constraint_leak',
      detail: `"${constraint.trim()}" is dietary or religious language, which is never spoken.`,
    });
  }

  const algo = matchFirst(flat, ALGORITHM_TERMS);
  if (algo) {
    violations.push({
      code: 'algorithm_leak',
      detail: `"${algo.trim()}" explains the system. Say it in the language of taste instead.`,
    });
  }

  const metric = matchFirst(folded, PEOPLE_METRIC_PATTERNS);
  if (metric) {
    violations.push({
      code: 'number_about_people',
      detail: `"${metric.trim()}" is a number about a person. Numbers about places only.`,
    });
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve',
];

function spell(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Trailing period without doubling one the source string already had. */
function sentence(s: string): string {
  const t = s.trim();
  return /[.?!]$/.test(t) ? t : `${t}.`;
}

/**
 * Deterministic render with no network call.
 *
 * Built from the same packet fields the live path gets, and it must pass
 * validateRendering for every packet shape. That is the point: the dry path is
 * not a placeholder string, it is a second implementation of the same contract,
 * so the API key landing changes voice quality and nothing else.
 */
export function dryRunRender(packet: EvidencePacket): string {
  const dish = packet.dish.name;
  const venue = packet.dish.venueName;
  const axis = packet.userAxes[0];
  const baseline = packet.populationBaseline;
  const twin = twinChannelAllowed(packet) ? packet.twinSupport : undefined;
  const caveat = packet.caveats[0];

  const out: string[] = [];

  out.push(sentence(`${venue}, get the ${dish}`));

  // Sentence two: why this pick, and how it differs from the room. The
  // divergence is the most informative thing we can say, so it never gets cut.
  const room = baseline
    ? `, which is not what the room does here, the room orders ${baseline.topDishName}`
    : '';
  if (twin) {
    const basis = axis ? `share your thing about ${axis.label}` : 'eat the way you do';
    out.push(sentence(`${capitalize(spell(twin.n))} people who ${basis} picked it${room}`));
  } else if (axis) {
    const side = axis.value >= 0 ? 'high end' : 'low end';
    out.push(sentence(`It sits at the ${side} of ${axis.label}, where you sit${room}`));
  } else {
    out.push(sentence(`It is the honest order${room}`));
  }

  // Sentence three: the downside. Attribution only when the twin gate is open,
  // because "two of them said" is a claim that a group of similar diners exists.
  if (caveat) {
    if (twin && caveat.source === 'twin_note' && caveat.n > 0) {
      out.push(
        sentence(`${capitalize(spell(caveat.n))} of them flagged the same thing, ${caveat.claim}`),
      );
    } else {
      out.push(sentence(`Worth knowing before you go, ${caveat.claim}`));
    }
  } else if (packet.confidence === 'low') {
    out.push(sentence('Nobody has flagged a problem with it yet, which is not the same as nobody having one'));
  } else {
    out.push(sentence(`Skip it if you want the thing everyone else at ${venue} is having`));
  }

  // Sentence four exists only to hedge, and only when there is something to
  // hedge about. Four short sentences already reads long in a message thread.
  if (packet.confidence === 'low' && out.length < MAX_SENTENCES && caveat) {
    out.push(sentence('Treat this as a lead rather than a promise, we have thin evidence on it'));
  }

  return out.join(' ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class RenderValidationError extends Error {
  readonly violations: Violation[];
  readonly lastText: string;
  readonly attempts: number;

  constructor(violations: Violation[], lastText: string, attempts: number) {
    super(
      `Render failed validation after ${attempts} attempts: ` +
        violations.map((v) => `[${v.code}] ${v.detail}`).join(' | '),
    );
    this.name = 'RenderValidationError';
    this.violations = violations;
    this.lastText = lastText;
    this.attempts = attempts;
  }
}

export interface GenerateRequest {
  system: string;
  messages: Anthropic.MessageParam[];
}

export interface RenderOptions {
  /** Stable id for the packet. Derived from packet content when not supplied. */
  packetId?: string;
  dishId?: string | null;
  /** Bounded repair attempts, including the first. */
  maxAttempts?: number;
  /** Force the deterministic path on or off. Defaults to "on when there is no key". */
  dryRun?: boolean;
  /**
   * Where the text comes from. Defaults to the Anthropic call, and supplying it
   * takes precedence over the dry-run default so a caller that already holds a
   * client can pass one. It changes where text comes from, never whether the
   * text is validated, which is why the validation loop lives outside it.
   */
  generate?: (req: GenerateRequest) => Promise<string>;
}

/** FNV-1a, same as the corpus pipeline, so packet ids are stable across machines. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function derivePacketId(packet: EvidencePacket): string {
  return `pkt_${hash(JSON.stringify(packet)).toString(36)}`;
}

/**
 * Dry run is the default whenever there is no key, checked at call time rather
 * than at import time so a test can set the environment after the module loads.
 */
function dryRunEnabled(override?: boolean): boolean {
  if (override !== undefined) return override;
  if (process.env.RENDER_DRY_RUN === '1') return true;
  // Gateway holds the provider credential, so its URL alone is enough to go live.
  return !hasModelCredentials();
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Routed through Merge Gateway when configured. Gateway sees model traffic
  // only and never touches HRIS data, so it carries no Article 9 exposure;
  // see docs/TRACK-C-MERGE-BRIEF.md.
  if (!client) client = new Anthropic(anthropicClientOptions());
  return client;
}

/** The live transport. Text only: everything about rules is handled by the caller. */
async function liveGenerate(req: GenerateRequest): Promise<string> {
  const res = await anthropic().messages.create({
    model: RENDER_MODEL,
    max_tokens: 400,
    system: req.system,
    messages: req.messages,
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Models sometimes wrap the line in quotes or announce themselves first. */
function cleanModelText(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/, '');
  t = t.replace(/^[A-Z][^.\n:]{0,60}:\s*\n+/, '');
  if (/^["'“]/.test(t) && /["'”]$/.test(t)) t = t.slice(1, -1).trim();
  return t;
}

/**
 * Render one evidence packet into two to four sentences.
 *
 * Guarantees: the returned text has passed validateRendering against this exact
 * packet. It never returns unvalidated text. When the model cannot produce a
 * conforming line within maxAttempts it throws RenderValidationError carrying
 * the violations and the last attempt, because a silent fallback to
 * "recommendation unavailable" hides a prompt regression until a demo.
 */
export async function renderRecommendation(
  packet: EvidencePacket,
  options: RenderOptions = {},
): Promise<RenderedRecommendation> {
  const { packetId = derivePacketId(packet), dishId = null, maxAttempts = MAX_ATTEMPTS } = options;

  const finish = (text: string): RenderedRecommendation => ({
    packetId,
    text,
    dishId,
    sourceChannel: packet.sourceChannel,
  });

  if (!options.generate && dryRunEnabled(options.dryRun)) {
    const text = dryRunRender(packet);
    const check = validateRendering(text, packet);
    // The deterministic path failing its own validator is a bug in this file,
    // not a model problem, and it must surface immediately rather than ship a
    // rule-breaking line under the cover of "it was only the dry run".
    if (!check.ok) throw new RenderValidationError(check.violations, text, 1);
    return finish(text);
  }

  const generate = options.generate ?? liveGenerate;
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `${buildPacketBrief(packet)}\n\nWrite the recommendation.` },
  ];

  let lastText = '';
  let lastViolations: Violation[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastText = cleanModelText(await generate({ system: SYSTEM_PROMPT, messages }));

    const check = validateRendering(lastText, packet);
    if (check.ok) return finish(lastText);
    lastViolations = check.violations;

    // Feed the violations back verbatim. A generic "try again" produces a
    // reworded version of the same failure; the specific offending span does not.
    messages.push({ role: 'assistant', content: lastText });
    messages.push({
      role: 'user',
      content:
        `That breaks the rules:\n` +
        check.violations.map((v) => `- ${v.detail}`).join('\n') +
        `\n\nRewrite it. Same packet, same facts, nothing new. Output only the recommendation.`,
    });
  }

  throw new RenderValidationError(lastViolations, lastText, maxAttempts);
}

export const __testing = {
  SYSTEM_PROMPT,
  ENTHUSIASM_PATTERNS,
  TWIN_LANGUAGE_PATTERNS,
  TWIN_CONCEPT_PATTERNS,
  fold,
  countClauses,
  findUngroundedProperNouns,
  findUngroundedDishes,
  findUngroundedAmounts,
  findAxisCohort,
  mentionsAnyCaveat,
  cleanModelText,
  derivePacketId,
  dryRunEnabled,
};
