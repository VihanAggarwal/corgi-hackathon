/**
 * Corpus pipeline driver. Track A.
 *
 *   npx tsx scripts/corpus/run.ts            live, needs keys
 *   CORPUS_DRY_RUN=1 npx tsx scripts/corpus/run.ts
 *
 * Resumable: every stage checkpoints, so a rerun after a crash picks up where
 * it stopped and costs nothing for completed work.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AXIS_COUNT } from '../../contracts/axes';
import { CONSTANTS } from '../../contracts/types';
import { Checkpoint } from './checkpoint';
import { CORPUS, DRY_RUN, PATHS, TARGET_NEIGHBORHOOD } from './config';
import { extractBatch, type ExtractionResult, type MenuItem } from './extract';
import { fetchMenu, type MenuFetchResult } from './menu';
import { fetchVenues, type VenueRecord } from './places';

/** Run `limit` tasks at a time. Keeps us inside API rate limits. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log(
    `\ncorpus: ${TARGET_NEIGHBORHOOD.name}  ${DRY_RUN ? '[DRY RUN, no network calls]' : '[LIVE]'}\n`,
  );

  // -- Stage 1: venues -------------------------------------------------------
  const venueCp = new Checkpoint<VenueRecord & { key: string }>('venues');
  let venues: VenueRecord[];
  if (venueCp.size >= CORPUS.targetVenues) {
    venues = venueCp.all();
    console.log(`venues: ${venues.length} from checkpoint`);
  } else {
    venues = await fetchVenues(CORPUS.targetVenues);
    for (const v of venues) if (!venueCp.has(v.key)) venueCp.record(v);
    console.log(`venues: ${venues.length} fetched`);
  }
  await venueCp.close();

  // -- Stage 2: menus --------------------------------------------------------
  const menuCp = new Checkpoint<MenuFetchResult>('menus');
  const menuPending = menuCp.pending(venues, (v) => v.key);
  console.log(`menus: ${menuCp.size} cached, ${menuPending.length} to fetch`);

  await pool(menuPending, 6, async (venue) => {
    const result = await fetchMenu(venue, null);
    menuCp.record(result);
    return result;
  });
  await menuCp.close();

  const allItems: MenuItem[] = menuCp.all().flatMap((m) => m.items);
  const failures = menuCp.all().filter((m) => m.failureReason);
  console.log(
    `menus: ${allItems.length} dishes from ${venues.length - failures.length} venues ` +
      `(${failures.length} produced nothing)`,
  );

  // -- Stage 3: extraction ---------------------------------------------------
  const extractCp = new Checkpoint<ExtractionResult>('extractions');
  const toExtract = extractCp.pending(allItems, (i) => i.key).slice(0, CORPUS.targetDishes);
  const batches = chunk(toExtract, CORPUS.extractionBatchSize);
  console.log(
    `extract: ${extractCp.size} cached, ${toExtract.length} to go in ${batches.length} batches`,
  );

  let completed = 0;
  let parked = 0;
  await pool(batches, CORPUS.extractionConcurrency, async (batch) => {
    for (let attempt = 1; attempt <= CORPUS.maxRetries; attempt++) {
      try {
        const results = await extractBatch(batch);
        for (const r of results) extractCp.record(r);
        completed += results.length;
        if (completed % 500 < CORPUS.extractionBatchSize) {
          console.log(`  ...${completed}/${toExtract.length}`);
        }
        return;
      } catch (err) {
        if (attempt === CORPUS.maxRetries) {
          parked += batch.length;
          console.warn(`  batch parked after ${attempt} attempts: ${(err as Error).message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      }
    }
  });
  await extractCp.close();

  // -- Coverage report -------------------------------------------------------
  const all = extractCp.all();
  const axisConfident = new Array(AXIS_COUNT).fill(0);
  let fullyAbstained = 0;
  for (const r of all) {
    if (r.abstainedEntirely) fullyAbstained++;
    for (let i = 0; i < AXIS_COUNT; i++) {
      if (r.confidence[i] >= CONSTANTS.CONF_THRESHOLD) axisConfident[i]++;
    }
  }

  const report = {
    neighborhood: TARGET_NEIGHBORHOOD.name,
    dryRun: DRY_RUN,
    venues: venues.length,
    venuesWithNoMenu: failures.length,
    dishes: all.length,
    dishesFullyAbstained: fullyAbstained,
    dishesParked: parked,
    meanConfidentAxesPerDish:
      all.length === 0
        ? 0
        : Number(
            (all.reduce((s, r) => s + (AXIS_COUNT - r.maskedAxes.length), 0) / all.length).toFixed(2),
          ),
    elapsedSec: Math.round((Date.now() - started) / 1000),
  };

  mkdirSync(PATHS.checkpoints, { recursive: true });
  writeFileSync(join(PATHS.checkpoints, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n--- corpus report ---');
  for (const [k, v] of Object.entries(report)) console.log(`${k.padEnd(28)} ${v}`);
  console.log(
    `\nfully abstained: ${((fullyAbstained / Math.max(all.length, 1)) * 100).toFixed(1)}% ` +
      `(high is honest, not broken)\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
