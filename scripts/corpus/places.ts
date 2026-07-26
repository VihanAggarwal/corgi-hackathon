/**
 * Google Places venue ingestion. Track A.
 *
 * Licensed API only. There is no scraping path in this file and there must
 * never be one: the Round 1 cut on scraping stands, and a ToS breach is not
 * survivable for a product whose entire pitch is trustworthiness.
 */

import { DRY_RUN, KEYS, TARGET_NEIGHBORHOOD } from './config';

export interface VenueRecord {
  /** Stable key for checkpointing. */
  key: string;
  gplaceId: string;
  name: string;
  lat: number;
  lng: number;
  priceBand: 1 | 2 | 3 | 4;
  neighborhood: string;
  /** Primary cuisine type, used as weak context for extraction only. */
  cuisine: string | null;
  /**
   * Coarse popularity by hour, from the Places aggregate. This is the honest
   * version of the source doc's foot traffic idea: it is a feature that tells a
   * user whether they will wait, not a moat.
   */
  popularTimes: unknown | null;
}

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.priceLevel',
  'places.primaryType',
  'places.types',
].join(',');

const PRICE_BAND: Record<string, 1 | 2 | 3 | 4> = {
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

interface PlacesResponse {
  places?: Array<{
    id: string;
    displayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
    priceLevel?: string;
    primaryType?: string;
    types?: string[];
  }>;
}

function humanizeType(t: string | undefined): string | null {
  if (!t) return null;
  // "chinese_restaurant" -> "chinese"
  const cleaned = t.replace(/_restaurant$/, '').replace(/_/g, ' ');
  return cleaned === 'restaurant' || cleaned === 'food' ? null : cleaned;
}

/**
 * Nearby search, paged. Places caps a single search at 20 results, so the
 * neighborhood is covered by tiling offset centers rather than by requesting a
 * larger radius, which would just return the same 20 popular venues.
 */
export async function fetchVenues(target = 300): Promise<VenueRecord[]> {
  if (DRY_RUN) return dryRunVenues(target);

  const { lat, lng, radiusM, name } = TARGET_NEIGHBORHOOD;
  const seen = new Map<string, VenueRecord>();

  // 5x5 tiling over the target area. Each tile gets its own 20-result budget.
  const tiles = 5;
  // ~111km per degree of latitude; longitude shrinks by cos(lat).
  const spanDeg = radiusM / 111_000;
  const lngScale = 1 / Math.cos((lat * Math.PI) / 180);

  for (let ty = 0; ty < tiles && seen.size < target; ty++) {
    for (let tx = 0; tx < tiles && seen.size < target; tx++) {
      const cy = lat + (ty / (tiles - 1) - 0.5) * 2 * spanDeg;
      const cx = lng + (tx / (tiles - 1) - 0.5) * 2 * spanDeg * lngScale;

      const body = {
        includedTypes: ['restaurant'],
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: { latitude: cy, longitude: cx },
            radius: (radiusM / tiles) * 1.4,
          },
        },
      };

      const res = await fetch(PLACES_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': KEYS.googlePlaces,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Places searchNearby failed ${res.status}: ${detail.slice(0, 300)}`);
      }

      const json = (await res.json()) as PlacesResponse;
      for (const p of json.places ?? []) {
        if (!p.id || seen.has(p.id)) continue;
        if (p.location?.latitude == null || p.location?.longitude == null) continue;
        seen.set(p.id, {
          key: p.id,
          gplaceId: p.id,
          name: p.displayName?.text ?? 'Unknown',
          lat: p.location.latitude,
          lng: p.location.longitude,
          priceBand: PRICE_BAND[p.priceLevel ?? ''] ?? 2,
          neighborhood: name,
          cuisine: humanizeType(p.primaryType),
          popularTimes: null,
        });
      }
    }
  }

  return [...seen.values()].slice(0, target);
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

const DRY_CUISINES = [
  'chinese', 'italian', 'japanese', 'mexican', 'thai', 'korean', 'indian',
  'vietnamese', 'french', 'greek', 'ethiopian', 'peruvian', 'turkish', 'polish',
];

function dryRunVenues(target: number): VenueRecord[] {
  const out: VenueRecord[] = [];
  const { lat, lng, name } = TARGET_NEIGHBORHOOD;
  for (let i = 0; i < target; i++) {
    const cuisine = DRY_CUISINES[i % DRY_CUISINES.length];
    out.push({
      key: `dry-place-${i}`,
      gplaceId: `dry-place-${i}`,
      name: `${cuisine[0].toUpperCase()}${cuisine.slice(1)} House ${i}`,
      lat: lat + ((i % 17) - 8) * 0.0009,
      lng: lng + ((i % 13) - 6) * 0.0011,
      priceBand: ((i % 4) + 1) as 1 | 2 | 3 | 4,
      neighborhood: name,
      cuisine,
      popularTimes: null,
    });
  }
  return out;
}
