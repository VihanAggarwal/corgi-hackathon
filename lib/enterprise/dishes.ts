/**
 * Dish candidates for the enterprise dinner planner. Track C.
 *
 * lib/enterprise/dinner.ts already defines the seam it needs, DinnerDishSource.
 * This file's only job is to satisfy that seam against the corpus Track A owns:
 * `venues` and `dishes` in contracts/schema.sql. Nothing here is dinner-specific
 * business logic. Radius, budget and party size are re-applied by
 * prefilterDishes in dinner.ts, so this module is free to over-return.
 *
 * NO CREDENTIALS, NO CRASH
 * Same shape as lib/db/constraints.ts and lib/enterprise/members.ts: with no
 * SUPABASE_SERVICE_ROLE_KEY this returns no candidates rather than throwing.
 * planTeamDinner already treats zero candidates as an honest "nothing nearby"
 * result, which is also the correct thing to say when there is no database to
 * ask, and it is what keeps the route runnable today with no keys at all.
 *
 * BOUNDING BOX, NOT A PRECISE RADIUS
 * schema.sql stores lat/lng as plain doubles with no PostGIS extension, so
 * there is no server-side great-circle query available. This narrows the
 * request to a generous lat/lng box before it reaches JS at all, and
 * prefilterDishes does the exact haversine check afterward. A box can only
 * over-select, never under-select, so the final radius stays exact.
 *
 * ============================== UNVERIFIED ==============================
 * The wire shape of a pgvector column through PostgREST has not been checked
 * against a live project, because there is no project yet. PostgREST has no
 * native vector encoder, so `phi` is expected to arrive as its text form,
 * "[0.1,0.2,...]", which happens to be valid JSON. parseVector accepts that or
 * an already-decoded array, so a client library change that starts returning a
 * real array costs nothing here.
 * ========================================================================
 */

import { AXIS_COUNT } from '../../contracts/axes';
import type { Conf24, EnterpriseDinnerRequest, Vec24 } from '../../contracts/types';
import { getServiceClient, hasServiceRoleCredentials } from '../db';
import type { DinnerDish, DinnerDishSource } from './dinner';

/** Roughly accurate at any latitude worth planning a dinner at. */
const METERS_PER_LAT_DEGREE = 111_320;

/**
 * Ceiling on the box, independent of the requested radius.
 *
 * MAX_RADIUS_M in dinner.ts is 50km, which alone bounds this. The separate cap
 * exists so a future change to that constant cannot silently turn this query
 * into a full table scan.
 */
const MAX_BOX_DEGREES = 2;

/** Rows fetched per table. A shortlist planner has no honest use for more. */
const MAX_VENUE_ROWS = 500;
const MAX_DISH_ROWS = 2000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function boxDegrees(lat: number, radiusM: number): { latPad: number; lngPad: number } {
  const latPad = Math.min(MAX_BOX_DEGREES, radiusM / METERS_PER_LAT_DEGREE);
  // Guard against cos() collapsing to zero near the poles, which would turn
  // the longitude pad into an unbounded box instead of a narrow one.
  const metersPerLngDegree = METERS_PER_LAT_DEGREE * Math.max(0.01, Math.cos(toRadians(lat)));
  const lngPad = Math.min(MAX_BOX_DEGREES, radiusM / metersPerLngDegree);
  return { latPad, lngPad };
}

/**
 * Decode a vector-shaped column value. See the UNVERIFIED note above.
 *
 * Guarantees: returns an array of exactly `length` finite numbers, or null.
 * Never throws, because a corpus row this cannot parse is a row to skip, not a
 * reason to fail the whole dinner.
 */
export function parseVector(raw: unknown, length: number): number[] | null {
  let values: unknown;
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string') {
    try {
      values = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (!Array.isArray(values) || values.length !== length) return null;
  const nums = (values as unknown[]).map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

interface VenueRow {
  id: string;
  name: string;
  neighborhood: string | null;
  lat: number;
  lng: number;
}

interface DishRow {
  id: string;
  venue_id: string;
  name: string;
  description: string | null;
  price_cents: number | null;
  phi: unknown;
  phi_confidence: unknown;
}

/**
 * Build the Supabase-backed dish source.
 *
 * Guarantees:
 *  - Never reads the environment or touches the network at construction. Every
 *    call re-checks hasServiceRoleCredentials(), so a key that appears mid
 *    process starts working with no restart.
 *  - Returns [] rather than throwing when there is no service-role credential,
 *    when the bounding box matches no venue, or for an individual dish whose
 *    phi does not parse. dinner.ts's own prefilter still runs the exact radius,
 *    budget, and vector-length check, so over-fetching here cannot widen the
 *    final candidate set.
 *  - A query error throws with no row detail attached, the same convention as
 *    lib/db/constraints.ts and lib/enterprise/members.ts.
 */
export function supabaseDishSource(): DinnerDishSource {
  return {
    async candidatesForDinner(request: EnterpriseDinnerRequest): Promise<readonly DinnerDish[]> {
      if (!hasServiceRoleCredentials()) return [];
      const client = getServiceClient();
      const { latPad, lngPad } = boxDegrees(request.lat, request.radiusM);

      const { data: venues, error: venueError } = await client
        .from('venues')
        .select('id, name, neighborhood, lat, lng')
        .gte('lat', request.lat - latPad)
        .lte('lat', request.lat + latPad)
        .gte('lng', request.lng - lngPad)
        .lte('lng', request.lng + lngPad)
        .limit(MAX_VENUE_ROWS);

      if (venueError) throw new Error('Venue lookup failed.');
      const venueRows = (venues ?? []) as VenueRow[];
      if (venueRows.length === 0) return [];

      const venueById = new Map(venueRows.map((v) => [v.id, v]));
      const { data: dishes, error: dishError } = await client
        .from('dishes')
        .select('id, venue_id, name, description, price_cents, phi, phi_confidence')
        .in('venue_id', [...venueById.keys()])
        .not('phi', 'is', null)
        .limit(MAX_DISH_ROWS);

      if (dishError) throw new Error('Dish lookup failed.');

      const out: DinnerDish[] = [];
      for (const row of (dishes ?? []) as DishRow[]) {
        const venue = venueById.get(row.venue_id);
        if (!venue) continue;
        const phi = parseVector(row.phi, AXIS_COUNT);
        // A dish we cannot read a preference vector for cannot be ranked. It is
        // dropped rather than scored as neutral, which would fake a fit.
        if (!phi) continue;
        const confidence = parseVector(row.phi_confidence, AXIS_COUNT);

        out.push({
          id: row.id,
          name: row.name,
          description: row.description,
          venueId: row.venue_id,
          venueName: venue.name,
          neighborhood: venue.neighborhood ?? '',
          lat: venue.lat,
          lng: venue.lng,
          priceCents: row.price_cents ?? null,
          phi: phi as Vec24,
          ...(confidence ? { confidence: confidence as Conf24 } : {}),
        });
      }
      return out;
    },
  };
}

/**
 * The dish source to use when a caller has no opinion.
 *
 * Live when a service-role credential exists, empty otherwise. Empty is the
 * honest answer with no database: no dishes means no dinner to plan, which is
 * the same "nothing nearby" result an organizer would see from a real corpus
 * with nothing in range.
 */
export function defaultDinnerDishSource(): DinnerDishSource {
  if (hasServiceRoleCredentials()) return supabaseDishSource();
  return {
    async candidatesForDinner(): Promise<readonly DinnerDish[]> {
      return [];
    },
  };
}
