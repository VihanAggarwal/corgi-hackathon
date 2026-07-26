/**
 * TRACK B MOCK FIXTURES.
 *
 * Hardcoded objects typed against /contracts/types.ts so every surface can be
 * built and judged before Track A's model and Track C's routes exist.
 *
 * This file is the ONLY place fake data lives. Nothing here is imported by a
 * component directly — everything goes through `components/data`, which is the
 * one module that gets swapped at the integration pass.
 *
 * Anything rendered from this file must be labelled "seeded demo data" on
 * screen when it could be mistaken for real usage (see /app/demo).
 */

import type {
  ComparisonResult,
  Dish,
  DuelCard,
  EvidencePacket,
  PalatePortrait,
  PalateRegion,
  RenderedRecommendation,
  TwinStatus,
  UserVector,
  Venue,
} from "@/contracts/types";
import { AXIS_COUNT } from "@/contracts/axes";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const zeros = (): number[] => new Array(AXIS_COUNT).fill(0);

/** Sparse vector literal -> full length-24 vector, by axis index. */
function vec(entries: Record<number, number>): number[] {
  const v = zeros();
  for (const [i, value] of Object.entries(entries)) v[Number(i)] = value;
  return v;
}

const confidence = (base = 0.82): number[] =>
  new Array(AXIS_COUNT).fill(base).map((c, i) => (i % 7 === 3 ? 0.44 : c));

// ---------------------------------------------------------------------------
// venues
// ---------------------------------------------------------------------------

export const VENUES: Venue[] = [
  { id: "v1", gplaceId: null, name: "Hunan Slurp", lat: 40.727, lng: -73.988, priceBand: 2, neighborhood: "East Village", noiseLevel: 2 },
  { id: "v2", gplaceId: null, name: "Wu's Wonton King", lat: 40.713, lng: -73.991, priceBand: 2, neighborhood: "Two Bridges", noiseLevel: 4 },
  { id: "v3", gplaceId: null, name: "Kopitiam", lat: 40.714, lng: -73.99, priceBand: 2, neighborhood: "Lower East Side", noiseLevel: 2 },
  { id: "v4", gplaceId: null, name: "Ras Plant Based", lat: 40.68, lng: -73.958, priceBand: 2, neighborhood: "Crown Heights", noiseLevel: 2 },
  { id: "v5", gplaceId: null, name: "Sami's Kabab House", lat: 40.762, lng: -73.918, priceBand: 1, neighborhood: "Astoria", noiseLevel: 3 },
  { id: "v6", gplaceId: null, name: "Nom Wah Tea Parlor", lat: 40.714, lng: -73.998, priceBand: 2, neighborhood: "Chinatown", noiseLevel: 3 },
  { id: "v7", gplaceId: null, name: "Casa Adela", lat: 40.724, lng: -73.981, priceBand: 1, neighborhood: "Loisaida", noiseLevel: 2 },
  { id: "v8", gplaceId: null, name: "Laut Singapura", lat: 40.737, lng: -73.988, priceBand: 3, neighborhood: "Union Square", noiseLevel: 3 },
  { id: "v9", gplaceId: null, name: "Yaso Tangbao", lat: 40.689, lng: -73.987, priceBand: 1, neighborhood: "Downtown Brooklyn", noiseLevel: 3 },
  { id: "v10", gplaceId: null, name: "Taqueria Ramírez", lat: 40.727, lng: -73.955, priceBand: 1, neighborhood: "Greenpoint", noiseLevel: 3 },
];

const venueName = (id: string) => VENUES.find((v) => v.id === id)!.name;
const venueHood = (id: string) => VENUES.find((v) => v.id === id)!.neighborhood;

// ---------------------------------------------------------------------------
// dishes
//
// The diagnostic pool (verified: true) is what a duel draws from. Calibration
// fits on these only — hard rule 7.
// ---------------------------------------------------------------------------

function dish(
  id: string,
  venueId: string,
  name: string,
  description: string,
  priceCents: number,
  phi: Record<number, number>,
  verified = true,
): Dish {
  return {
    id,
    venueId,
    name,
    description,
    priceCents,
    vector: { phi: vec(phi), confidence: confidence(), maskedAxes: [] },
    verified,
    imageUrl: null,
    lastExtractedAt: "2026-07-24T18:02:00.000Z",
  };
}

/*
 * phi indices, for reading the literals below:
 *  0 heat_capsaicin   1 heat_numbing    2 acid            3 salt
 *  4 sweetness_savory 5 sweetness_dsrt  6 fat_richness    7 umami_depth
 *  8 bitterness       9 funk_ferment   10 char_smoke     11 herb_freshness
 * 12 aromatic_spice  13 garlic_allium  14 texture_crunch 15 texture_chew
 * 16 texture_creamy  17 temp_served    18 portion_format 19 protein_prominence
 * 20 prep_novelty    21 ingredient_familiar 22 price_per_satiety 23 effort_to_eat
 */

export const DISHES: Dish[] = [
  dish("d1", "v1", "Liang pi", "Cold hand-torn wheat noodles, chili oil, black vinegar, gluten cubes", 1400,
    { 0: 1.4, 2: 1.9, 6: -0.4, 9: 0.8, 15: 1.6, 17: -2.1, 20: 0.7, 22: 0.6 }),
  dish("d2", "v1", "Hunan rice noodle soup", "Pork bone broth, pickled long bean, chili crisp", 1600,
    { 0: 1.1, 3: 1.2, 7: 2.0, 9: 1.1, 16: 0.4, 17: 2.2, 19: 0.9 }),
  dish("d3", "v2", "Salt and pepper squid", "Fried, tossed with jalapeño and garlic", 2200,
    { 0: 0.6, 3: 1.8, 6: 1.4, 10: 0.8, 13: 1.5, 14: 2.2, 19: 1.2, 23: 0.9 }),
  dish("d4", "v2", "Steamed flounder, ginger and scallion", "Whole fish, soy, hot oil poured at the table", 4200,
    { 2: 0.4, 3: 0.6, 7: 1.1, 11: 1.3, 13: 1.0, 16: 0.7, 17: 1.8, 19: 1.6, 23: 1.7 }),
  dish("d5", "v3", "Nasi lemak", "Coconut rice, sambal, fried anchovy, egg, cucumber", 1800,
    { 0: 1.6, 3: 1.4, 4: 0.9, 6: 1.5, 7: 1.3, 9: 1.7, 14: 1.1, 16: 1.2, 22: 1.4 }),
  dish("d6", "v3", "Kaya toast set", "Pandan coconut jam, cold butter, soft eggs, white pepper", 1200,
    { 4: 2.2, 5: 1.8, 6: 1.6, 14: 1.4, 16: 1.3, 20: 0.8, 22: 1.1 }),
  dish("d7", "v4", "Timatim salad", "Tomato, jalapeño, injera, lemon", 1400,
    { 0: 0.9, 2: 2.1, 6: -1.6, 11: 1.7, 17: -1.4, 19: -2.0, 22: -0.3 }),
  dish("d8", "v4", "Misir wot", "Red lentil, berbere, slow-cooked", 1700,
    { 0: 1.7, 3: 0.8, 7: 1.4, 12: 2.3, 16: 1.5, 19: -1.7, 22: 1.6 }),
  dish("d9", "v5", "Chapli kabab", "Ground beef, coriander seed, tomato, flat and crisp-edged", 1300,
    { 0: 1.0, 3: 1.3, 6: 1.7, 10: 1.9, 11: 0.8, 12: 1.6, 14: 1.2, 19: 2.1, 22: 1.8 }),
  dish("d10", "v5", "Bolani", "Griddled flatbread, leek and potato, mint yogurt", 900,
    { 3: 0.4, 6: 0.7, 11: 1.4, 13: 1.1, 14: 0.9, 16: 1.0, 19: -1.4, 22: 2.0 }),
  dish("d11", "v6", "Shrimp and snow pea leaf dumpling", "Steamed, thin wrapper", 1000,
    { 3: -0.4, 7: 0.9, 11: 1.2, 15: 1.1, 17: 1.6, 19: 0.8, 21: 1.4 }),
  dish("d12", "v6", "Fried sesame ball", "Glutinous rice, red bean, sesame crust", 700,
    { 5: 1.9, 6: 1.3, 14: 1.5, 15: 2.3, 16: 0.6, 20: 0.5, 22: 1.7 }),
  dish("d13", "v7", "Pernil, rice and beans", "Slow-roast pork shoulder, garlic, crisp skin", 1500,
    { 3: 1.6, 6: 2.0, 10: 1.4, 13: 2.2, 14: 1.3, 19: 2.2, 21: 1.6, 22: 1.9 }),
  dish("d14", "v7", "Mofongo with garlic shrimp", "Mashed fried plantain, broth on the side", 1800,
    { 3: 1.2, 6: 1.8, 13: 2.4, 15: 1.4, 16: 0.5, 19: 1.1, 22: 1.2 }),
  dish("d15", "v8", "Laksa lemak", "Coconut curry noodle, cockles, tofu puff, sambal", 2100,
    { 0: 1.5, 3: 1.1, 4: 0.7, 6: 2.1, 7: 1.9, 9: 1.4, 12: 1.5, 16: 2.2, 17: 2.0 }),
  dish("d16", "v8", "Kangkung belacan", "Water spinach, fermented shrimp paste, chili", 1600,
    { 0: 1.4, 3: 1.5, 7: 1.6, 9: 2.4, 11: 0.6, 13: 1.3, 19: -1.2 }),
  dish("d17", "v9", "Sheng jian bao", "Pan-fried pork bun, soup inside, crisp bottom", 1100,
    { 3: 0.9, 4: 0.8, 6: 1.5, 7: 1.7, 10: 0.9, 14: 1.6, 15: 1.2, 17: 2.3, 23: 1.5 }),
  dish("d18", "v9", "Wood ear salad", "Black fungus, vinegar, chili, cilantro", 900,
    { 0: 0.8, 2: 2.3, 9: 0.7, 11: 1.5, 14: 1.8, 15: 1.9, 17: -1.8, 19: -2.1 }),
  dish("d19", "v10", "Suadero taco", "Confited beef, corn tortilla pressed to order", 500,
    { 3: 1.0, 6: 1.9, 10: 1.1, 11: 1.2, 16: 0.8, 19: 2.0, 21: 1.3, 22: 2.2, 23: 1.1 }),
  dish("d20", "v10", "Tripa taco", "Crisped beef tripe, lime, salsa verde", 500,
    { 2: 1.4, 3: 1.2, 6: 1.6, 9: 1.8, 10: 1.7, 14: 2.0, 19: 1.9, 21: -1.8, 23: 1.2 }),
];

export const DISH_BY_ID = new Map(DISHES.map((d) => [d.id, d]));

/**
 * Pair order matters: a duel is only informative if the two dishes disagree on
 * axes the user has not settled. These pairs are hand-picked to split on one
 * axis at a time, which is what Track A's information-gain selector will do
 * properly.
 */
export const DUEL_PAIRS: Array<[string, string]> = [
  ["d1", "d2"],
  ["d5", "d7"],
  ["d13", "d18"],
  ["d16", "d11"],
  ["d9", "d10"],
  ["d20", "d19"],
  ["d15", "d4"],
  ["d6", "d8"],
  ["d3", "d12"],
  ["d17", "d7"],
  ["d14", "d18"],
  ["d2", "d16"],
  ["d8", "d5"],
  ["d19", "d11"],
  ["d12", "d20"],
  ["d10", "d15"],
  ["d4", "d13"],
  ["d18", "d6"],
];

// ---------------------------------------------------------------------------
// share cards
// ---------------------------------------------------------------------------

function cardFrom(cardId: string, aId: string, bId: string): DuelCard {
  const a = DISH_BY_ID.get(aId)!;
  const b = DISH_BY_ID.get(bId)!;
  return {
    cardId,
    a: { dishId: a.id, name: a.name, venueName: venueName(a.venueId), imageUrl: a.imageUrl },
    b: { dishId: b.id, name: b.name, venueName: venueName(b.venueId), imageUrl: b.imageUrl },
    shareUrl: `/c/${cardId}`,
  };
}

/** The card the demo QR points at. Sender picked A. */
export const SEED_CARDS: DuelCard[] = [
  cardFrom("k3n7q", "d1", "d13"),
  cardFrom("m8x2v", "d16", "d6"),
  cardFrom("p4w9r", "d20", "d11"),
];

/** Who sent each seeded card. First name only; there is no profile to open. */
export const CARD_SENDERS: Record<string, string> = {
  k3n7q: "Kalyan",
  m8x2v: "Priya",
  p4w9r: "Dev",
};

// ---------------------------------------------------------------------------
// user state
// ---------------------------------------------------------------------------

export const USER_VECTOR: UserVector = {
  theta: vec({ 0: 1.2, 1: 1.6, 2: 2.1, 4: -1.9, 6: 0.3, 9: 1.4, 14: 1.1, 17: -0.8, 22: 0.7 }),
  nComparisons: 14,
  posteriorVar: 0.31,
  updatedAt: "2026-07-25T04:11:00.000Z",
};

/** Twins are off until the floors clear. When off, the UI says nothing. */
export const TWIN_STATUS_OFF: TwinStatus = {
  enabled: false,
  twinCount: 0,
  reason: "need_more_duels",
};

export const TWIN_STATUS_ON: TwinStatus = { enabled: true, twinCount: 9 };

export const PORTRAIT: PalatePortrait = {
  userId: "u_local",
  body: [
    "You are an acid person who has been telling everyone you are a heat person. You take the numbing option nearly every time it is offered, and then you take the vinegar option over the chili one, which is the tell.",
    "You have not once chosen the sweeter dish in a savory duel. Fourteen duels, zero. That is the strongest single thing on file about you and it is going to cost you: it rules out most of Malaysian, most of Shanghainese braising, and every dessert worth eating in this neighborhood.",
    "You pick cold dishes at a rate almost nobody does, and you pick them for texture rather than for temperature. Chewy, torn, springy. The wood ear salad over the pernil was not a close call for you.",
    "What you have not done is eat anything bitter on purpose. Not once. It is the largest blank space on your map and it is next to a region you already like, which is inconvenient, because it means you have no excuse.",
  ].join("\n\n"),
  containsUnflattering: true,
  generatedAt: "2026-07-25T04:12:00.000Z",
};

export const REGION_BEFORE: PalateRegion = {
  volume: 3.41,
  exploredAxes: ["acid", "heat_numbing", "texture_chew"],
  frontierAxes: ["bitterness", "sweetness_savory", "char_smoke", "protein_prominence", "funk_ferment", "temp_served"],
  measuredAt: "2026-07-11T00:00:00.000Z",
};

export const REGION_AFTER: PalateRegion = {
  volume: 4.86,
  exploredAxes: ["acid", "heat_numbing", "texture_chew", "funk_ferment", "texture_crunch", "char_smoke", "umami_depth"],
  frontierAxes: ["bitterness", "sweetness_savory", "protein_prominence"],
  measuredAt: "2026-07-25T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// comparison results
//
// Disagreement is the designed-for case. Agreement is the exception.
// ---------------------------------------------------------------------------

export const COMPARISON_DISAGREE: ComparisonResult = {
  agreementRate: 0.4,
  hardestDivergence: {
    axis: "sweetness_savory",
    label: "sweetness in savory food",
    aValue: -1.9,
    bValue: 1.4,
  },
  areTwins: false,
  verdictText:
    "You are not taste twins. You split on sweetness in savory food, and you split hard: Kalyan takes the sweeter option almost every time it is offered and you have never taken it once. You agreed on four of ten. Where you overlap is acid and crunch, so a cold noodle place is the safe answer for the two of you, and nothing braised.",
};

export const COMPARISON_AGREE: ComparisonResult = {
  agreementRate: 0.8,
  hardestDivergence: {
    axis: "effort_to_eat",
    label: "effort to eat",
    aValue: 0.4,
    bValue: -1.5,
  },
  areTwins: true,
  verdictText:
    "You are taste twins, which is rarer than it sounds and slightly boring for both of you. You agreed on eight of ten and the only real split is effort: you will work for a dish, Dev wants a fork and one plate. Send them the noodles, not the whole fish.",
};

// ---------------------------------------------------------------------------
// evidence packets and rendered recommendations
//
// Track A/C produce these. Track B only renders them, and only renders what is
// in them — every sentence below traces to a packet field.
// ---------------------------------------------------------------------------

export const PACKET_TWIN: EvidencePacket = {
  userAxes: [
    { axis: "sweetness_savory", label: "sweetness in savory food", value: -1.9, percentile: 4 },
    { axis: "acid", label: "acidity", value: 2.1, percentile: 96 },
  ],
  dish: {
    name: "Kangkung belacan",
    venueName: "Laut Singapura",
    neighborhood: "Union Square",
    priceCents: 1600,
    phiConfidence: "high",
  },
  twinSupport: {
    n: 6,
    lift: 0.31,
    kFloorMet: true,
    clusterDescriptor: "people who, like you, will not accept sweetness in savory food",
  },
  populationBaseline: { topDishName: "laksa lemak", topDishShare: 0.62 },
  caveats: [
    { source: "twin_note", n: 2, claim: "the shrimp paste reads much stronger here than at the Chinatown places" },
  ],
  expansion: { outsideRegion: true, axis: "funk_ferment", distance: "adjacent" },
  sourceChannel: "twin",
  confidence: "high",
  constraintsAppliedCount: 0,
};

export const PACKET_CONTENT: EvidencePacket = {
  userAxes: [
    { axis: "acid", label: "acidity", value: 2.1, percentile: 96 },
    { axis: "temp_served", label: "serving temperature", value: -0.8, percentile: 22 },
  ],
  dish: {
    name: "Wood ear salad",
    venueName: "Yaso Tangbao",
    neighborhood: "Downtown Brooklyn",
    priceCents: 900,
    phiConfidence: "medium",
  },
  populationBaseline: { topDishName: "sheng jian bao", topDishShare: 0.71 },
  caveats: [{ source: "extraction", n: 1, claim: "the vinegar level is inferred from the menu text, not confirmed" }],
  sourceChannel: "content",
  confidence: "medium",
  constraintsAppliedCount: 0,
};

export const RECOMMENDATIONS: RenderedRecommendation[] = [
  {
    packetId: "pk_twin_1",
    text: "Laut Singapura, get the kangkung belacan. Six people who share your refusal of sweetness in savory food picked it over the laksa, which is not what the room does here, the room orders laksa about two times in three. Two of them said the shrimp paste reads much stronger here than at the Chinatown places, so this is the funkiest thing you will have eaten on purpose.",
    dishId: "d16",
    sourceChannel: "twin",
  },
  {
    packetId: "pk_content_1",
    text: "Yaso Tangbao, the wood ear salad. It is cold, sharp and chewy, which is three of the four things you keep choosing, and it costs nine dollars. The vinegar level is inferred from the menu rather than confirmed, so if it lands flat that is on me, and the room here orders the sheng jian bao instead.",
    dishId: "d18",
    sourceChannel: "content",
  },
];

/** The one the agent sends after a menu photo. Vision channel. */
export const RECOMMENDATION_VISION: RenderedRecommendation = {
  packetId: "pk_vision_1",
  text: "Mapo tofu, from the photo you sent. It is the only thing on this menu with the numbing heat you keep picking, and the rest of it skews sweet, which you have passed on fourteen times running. I can only half read the right-hand column, so I am not going to guess at the specials.",
  dishId: null,
  sourceChannel: "agent_vision",
};

// ---------------------------------------------------------------------------
// demo screen activity. Labelled "seeded demo data" wherever it renders.
// ---------------------------------------------------------------------------

export interface DemoEvent {
  id: string;
  at: string;
  kind: "scan" | "duel" | "profile_formed" | "comparison";
  detail: string;
}

export const DEMO_EVENTS: DemoEvent[] = [
  { id: "e1", at: "-00:04:12", kind: "scan", detail: "card k3n7q opened, new device" },
  { id: "e2", at: "-00:04:05", kind: "duel", detail: "liang pi over pernil" },
  { id: "e3", at: "-00:03:44", kind: "duel", detail: "wood ear salad over sheng jian bao" },
  { id: "e4", at: "-00:02:58", kind: "profile_formed", detail: "12 duels, theta stable" },
  // No twin language in seeded activity: this row renders whether or not the
  // twin channel has cleared its floors.
  { id: "e5", at: "-00:02:31", kind: "comparison", detail: "split on sweetness in savory food" },
];

export const SEEDED_LABEL = "seeded demo data";

export { venueName, venueHood };
