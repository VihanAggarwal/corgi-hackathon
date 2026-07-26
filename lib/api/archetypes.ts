/**
 * House picks per taste archetype. Track C.
 *
 * WHY THIS EXISTS
 * The twin channel needs k >= 5 independent supporters before it may say a
 * word (hard rule 5), and on day one nobody has that. Without a fallback the
 * honest answer is "i have nothing", which is correct and also a terrible first
 * experience for the person who just spent ninety seconds calibrating.
 *
 * So: a small set of archetypes, each with a couple of places that genuinely
 * suit that palate, chosen by hand. This is the "a friend who has not asked
 * around yet still has opinions" case.
 *
 * WHAT THIS IS NOT
 * It is NOT the twin channel wearing a costume. An archetype pick is sourced
 * from the content channel and must be described as the system's own read, not
 * as other people's. Presenting a hand-written default as social proof would be
 * exactly the fabricated-cluster failure rule 5 exists to prevent.
 */

import { AXIS_KEYS, type AxisKey } from '@/contracts/axes';
import type { Vec24 } from '@/contracts/types';

export interface Archetype {
  key: string;
  /** How the agent describes this palate out loud, in axis language. */
  descriptor: string;
  /** Axes that define it, and the direction. Matched against a fitted theta. */
  signature: Partial<Record<AxisKey, number>>;
  /** Corpus venue ids, best first. Hand picked to suit the palate above. */
  venueIds: string[];
}

export const ARCHETYPES: Archetype[] = [
  {
    key: 'heat_and_numb',
    descriptor: 'you actually want the heat, not a suggestion of it',
    signature: { heat_capsaicin: 1.2, heat_numbing: 0.8, aromatic_spice: 0.5 },
    venueIds: ['v1', 'v2', 'v9'],
  },
  {
    key: 'funk_and_ferment',
    descriptor: 'you go for the funky, fermented end of things',
    signature: { funk_ferment: 1.3, umami_depth: 0.7, acid: 0.5 },
    venueIds: ['v3', 'v8', 'v4'],
  },
  {
    key: 'char_and_fat',
    descriptor: 'you eat for char and richness',
    signature: { char_smoke: 1.2, fat_richness: 1.0, protein_prominence: 0.8 },
    venueIds: ['v10', 'v5', 'v7'],
  },
  {
    key: 'sharp_and_fresh',
    descriptor: 'you want acid and freshness doing the work',
    signature: { acid: 1.2, herb_freshness: 1.0, fat_richness: -0.6 },
    venueIds: ['v8', 'v3', 'v6'],
  },
  {
    key: 'comfort_and_depth',
    descriptor: 'you go for deep, brothy, comforting food',
    signature: { umami_depth: 1.2, temp_served: 0.8, texture_chew: 0.5 },
    venueIds: ['v2', 'v6', 'v9'],
  },
  {
    key: 'veg_forward',
    descriptor: 'you eat vegetable led more than most people do',
    signature: { protein_prominence: -1.2, herb_freshness: 0.7, ingredient_familiar: -0.4 },
    venueIds: ['v4', 'v3', 'v8'],
  },
];

function axisIndex(key: AxisKey): number {
  return AXIS_KEYS.indexOf(key);
}

/**
 * The archetype a fitted vector sits closest to.
 *
 * Scored by dot product against the signature rather than by distance, so an
 * emphatic match on the axes that define an archetype wins over a vector that
 * is merely near it in every dimension. Returns null for a theta with nothing
 * to say, because guessing an archetype from noise is how somebody gets told
 * they love funk on the strength of two duels.
 */
export function matchArchetype(theta: Vec24, minScore = 0.35): Archetype | null {
  let best: Archetype | null = null;
  let bestScore = -Infinity;

  for (const a of ARCHETYPES) {
    let score = 0;
    let weight = 0;
    for (const [key, want] of Object.entries(a.signature) as Array<[AxisKey, number]>) {
      const i = axisIndex(key);
      if (i < 0) continue;
      score += theta[i] * want;
      weight += Math.abs(want);
    }
    const normalized = weight > 0 ? score / weight : 0;
    if (normalized > bestScore) {
      bestScore = normalized;
      best = a;
    }
  }

  return bestScore >= minScore ? best : null;
}
