/**
 * Menu acquisition. Track A.
 *
 * Sources, in priority order:
 *   1. The venue's own website (first-party, publicly served, robots-respecting)
 *   2. Nothing
 *
 * There is no option 3. A venue whose menu cannot be read contributes zero
 * dishes and is recorded as such. We never ask a model to invent a plausible
 * menu, because an invented dish is a dish a user can be sent to order and be
 * told does not exist, which destroys the only asset this product has.
 *
 * This is the same rule as the renderer's: the model reads, it does not author.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicClientOptions, DRY_RUN, EXTRACTION_MODEL } from './config';
import type { MenuItem } from './extract';
import type { VenueRecord } from './places';

export interface MenuFetchResult {
  key: string;
  venueKey: string;
  items: MenuItem[];
  /** Why a venue produced nothing, for the coverage report. */
  failureReason: 'no_website' | 'fetch_failed' | 'no_menu_found' | null;
}

const MENU_SYSTEM = `You read raw restaurant webpage text and extract the menu.

Return only a JSON array of dishes actually present in the text:
[{"name": "...", "description": "..." | null, "price_cents": 1800 | null}]

Rules:
- Only dishes that literally appear in the input. Never add a dish you expect a
  restaurant of this type to have. An invented dish is a serious error.
- Skip section headers, drinks, and non-food lines.
- description is the menu's own words, or null. Never write your own.
- price_cents is an integer. Null if no price is shown.
- If the text contains no menu, return [].
No prose, no markdown fence.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Routed through Merge Gateway when configured; see anthropicClientOptions.
  if (!client) client = new Anthropic(anthropicClientOptions());
  return client;
}

/** Strip markup down to the text a menu extractor can read. */
function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30_000);
}

interface RawDish {
  name?: string;
  description?: string | null;
  price_cents?: number | null;
}

export async function fetchMenu(
  venue: VenueRecord,
  websiteUrl: string | null,
): Promise<MenuFetchResult> {
  if (DRY_RUN) return dryRunMenu(venue);

  const base: Omit<MenuFetchResult, 'items' | 'failureReason'> = {
    key: venue.key,
    venueKey: venue.key,
  };

  if (!websiteUrl) return { ...base, items: [], failureReason: 'no_website' };

  let html: string;
  try {
    const res = await fetch(websiteUrl, {
      headers: { 'User-Agent': 'TasteTwins/0.1 (corpus builder; contact via repo)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ...base, items: [], failureReason: 'fetch_failed' };
    html = await res.text();
  } catch {
    return { ...base, items: [], failureReason: 'fetch_failed' };
  }

  const text = toText(html);
  if (text.length < 200) return { ...base, items: [], failureReason: 'no_menu_found' };

  const res = await anthropic().messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 8000,
    system: MENU_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });

  const raw = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let dishes: RawDish[];
  try {
    const parsed: unknown = JSON.parse(raw);
    dishes = Array.isArray(parsed) ? (parsed as RawDish[]) : [];
  } catch {
    return { ...base, items: [], failureReason: 'no_menu_found' };
  }

  const items: MenuItem[] = dishes
    .filter((d): d is RawDish & { name: string } => typeof d.name === 'string' && d.name.length > 1)
    .map((d) => ({
      key: `${venue.gplaceId}::${d.name}`,
      venueKey: venue.key,
      name: d.name,
      description: d.description ?? null,
      priceCents: typeof d.price_cents === 'number' ? d.price_cents : null,
      venueCuisine: venue.cuisine,
    }));

  return {
    ...base,
    items,
    failureReason: items.length === 0 ? 'no_menu_found' : null,
  };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/**
 * Synthetic menus per cuisine. These exist only to exercise the pipeline and
 * the demo without keys. They are clearly fictional and the demo screen must
 * label seeded data as seeded.
 */
const DRY_MENUS: Record<string, string[]> = {
  chinese: ['mapo tofu', 'liang pi', 'dan dan noodles', 'twice cooked pork', 'scallion pancake', 'hot and sour soup'],
  italian: ['cacio e pepe', 'bucatini amatriciana', 'vitello tonnato', 'burrata', 'osso buco', 'affogato'],
  japanese: ['chirashi', 'agedashi tofu', 'tsukemen', 'katsu curry', 'uni toast', 'chawanmushi'],
  mexican: ['al pastor taco', 'cochinita pibil', 'esquites', 'birria consomme', 'tlayuda', 'chile relleno'],
  thai: ['khao soi', 'som tam', 'boat noodles', 'pad see ew', 'larb', 'massaman curry'],
  korean: ['budae jjigae', 'gamjatang', 'jokbal', 'kalguksu', 'tteokbokki', 'yukhoe'],
  indian: ['dosa', 'chettinad chicken', 'dal makhani', 'bhel puri', 'rogan josh', 'kachori'],
  vietnamese: ['bun bo hue', 'banh xeo', 'ca kho to', 'goi cuon', 'com tam', 'che ba mau'],
  french: ['cassoulet', 'tarte flambee', 'blanquette de veau', 'escargot', 'pot au feu', 'ile flottante'],
  greek: ['moussaka', 'gigantes', 'grilled octopus', 'spanakopita', 'loukoumades', 'kokoretsi'],
  ethiopian: ['doro wat', 'kitfo', 'gomen', 'tibs', 'shiro', 'azifa'],
  peruvian: ['ceviche', 'lomo saltado', 'aji de gallina', 'anticuchos', 'causa', 'picarones'],
  turkish: ['iskender', 'manti', 'lahmacun', 'imam bayildi', 'kunefe', 'cig kofte'],
  polish: ['pierogi ruskie', 'bigos', 'zurek', 'golabki', 'placki ziemniaczane', 'kotlet schabowy'],
};

function dryRunMenu(venue: VenueRecord): MenuFetchResult {
  const dishes = DRY_MENUS[venue.cuisine ?? ''] ?? DRY_MENUS.italian;
  // ~27 dishes/venue x 300 venues lands near the 8,000 target.
  const items: MenuItem[] = [];
  for (let rep = 0; rep < 5; rep++) {
    for (const d of dishes) {
      const name = rep === 0 ? d : `${d} (${['small', 'large', 'special', 'lunch'][rep - 1]})`;
      items.push({
        key: `${venue.gplaceId}::${name}`,
        venueKey: venue.key,
        name,
        description: `seeded demo item, ${venue.cuisine} preparation`,
        priceCents: 1200 + ((name.length * 137) % 2800),
        venueCuisine: venue.cuisine,
      });
    }
  }
  return { key: venue.key, venueKey: venue.key, items, failureReason: null };
}
