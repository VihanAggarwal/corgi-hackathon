/**
 * Corpus pipeline configuration. Track A.
 *
 * Everything tunable about the corpus run lives here so a rerun is a config
 * edit, not a code edit.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

/** One neighborhood for the hackathon corpus. Everything is scoped to this. */
export const TARGET_NEIGHBORHOOD = {
  name: process.env.CORPUS_NEIGHBORHOOD ?? 'Lower East Side',
  lat: Number(process.env.CORPUS_LAT ?? 40.7185),
  lng: Number(process.env.CORPUS_LNG ?? -73.9875),
  /** Places nearby search radius. 1200m covers the LES without bleeding into SoHo. */
  radiusM: Number(process.env.CORPUS_RADIUS_M ?? 1200),
};

export const CORPUS = {
  /** Build spec target: ~300 venues. */
  targetVenues: 300,
  /** Build spec target: ~8000 dishes. */
  targetDishes: 8000,
  /** Hand-verified diagnostic pool size. Calibration fits ONLY on these. */
  verifiedPoolTarget: 200,
  /** Dishes per extraction call. Larger batches are cheaper but degrade abstention. */
  extractionBatchSize: 12,
  /** Concurrent extraction calls. Anthropic rate limits are the binding constraint. */
  extractionConcurrency: 4,
  /** Retries per batch before the batch is parked for manual review. */
  maxRetries: 3,
};

export const PATHS = {
  checkpoints: 'scripts/corpus/.checkpoints',
  cache: 'scripts/corpus/.cache',
};

/** Extraction model. Cheap enough for 8000 dishes, strong enough to abstain honestly. */
export const EXTRACTION_MODEL = 'claude-sonnet-5';

/** Renderer model. Voice quality matters more than cost here, volume is low. */
export const RENDER_MODEL = 'claude-opus-5';

export const KEYS = {
  anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  googlePlaces: process.env.GOOGLE_PLACES_API_KEY ?? '',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseServiceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
};

/**
 * Optional Merge Gateway routing for model calls.
 *
 * Gateway sits between us and the model providers: failover when one degrades,
 * plus cost and latency observability across the corpus run, which is by far
 * our largest token spend. Conference wifi is assumed to fail at least once, so
 * provider failover is worth having rather than a nice-to-have.
 *
 * It carries NO Article 9 exposure, because it never sees HRIS data. Only model
 * traffic passes through it. That separation is the reason this is safe to turn
 * on while the Merge HRIS path stays under the strict no-LLM rule documented in
 * docs/TRACK-C-MERGE-BRIEF.md.
 *
 * Unset means talk to Anthropic directly. Nothing else in the pipeline changes.
 */
export const GATEWAY = {
  baseUrl: process.env.MERGE_GATEWAY_BASE_URL ?? '',
  apiKey: process.env.MERGE_GATEWAY_API_KEY ?? '',
};

/**
 * Options for the Anthropic client, routed through Gateway when configured.
 *
 * Kept here rather than inline at each construction site so that Track A has
 * exactly one place to change if Gateway's contract turns out to differ from
 * what the docs imply. Both extract.ts and core/render.ts use this.
 */
export function anthropicClientOptions(): { apiKey: string; baseURL?: string } {
  if (GATEWAY.baseUrl) {
    return {
      // Gateway authenticates with its own key and holds the provider
      // credential. Fall back to the Anthropic key if only the URL is set.
      apiKey: GATEWAY.apiKey || KEYS.anthropic,
      baseURL: GATEWAY.baseUrl,
    };
  }
  return { apiKey: KEYS.anthropic };
}

/**
 * Dry run mode. When true the pipeline exercises every code path with
 * deterministic synthetic data and makes zero network calls.
 *
 * This exists so the pipeline is testable and demoable before keys land, and
 * so a dead venue wifi at hour 70 cannot break the demo.
 */
export const DRY_RUN =
  process.env.CORPUS_DRY_RUN === '1' || !KEYS.anthropic || !KEYS.googlePlaces;

export function requireKeys(names: Array<keyof typeof KEYS>): void {
  const missing = names.filter((n) => !KEYS[n]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. ` +
        `Copy .env.example to .env.local and fill it in, or set CORPUS_DRY_RUN=1.`,
    );
  }
}
