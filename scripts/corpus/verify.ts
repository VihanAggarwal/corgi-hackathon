/**
 * Human verification CLI for the diagnostic pool. Track A.
 *
 *   npx tsx scripts/corpus/verify.ts [count]
 *
 * Shows a dish and its extracted vector rendered as words, and takes y / n / f.
 * Approved dishes become `verified = true`, and hard rule 7 means model fitting
 * happens on these and nothing else.
 *
 * Sampling is deliberately biased toward high-confidence extractions, because
 * the pool exists to measure whether confident claims are actually right. A
 * pool of abstentions would score wonderfully and prove nothing.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AXES, AXIS_COUNT } from '../../contracts/axes';
import { CONSTANTS } from '../../contracts/types';
import { Checkpoint } from './checkpoint';
import { CORPUS, PATHS } from './config';
import type { ExtractionResult } from './extract';
import type { MenuFetchResult } from './menu';
import type { MenuItem } from './extract';

interface Verdict {
  key: string;
  verdict: 'correct' | 'wrong' | 'fixed';
  /** Axes the human marked as wrong, for the accuracy number. */
  wrongAxes: string[];
  at: string;
}

/** Render a vector as the words a human can actually check against a dish. */
function asWords(r: ExtractionResult): string[] {
  const out: { line: string; conf: number }[] = [];
  for (let i = 0; i < AXIS_COUNT; i++) {
    const c = r.confidence[i];
    if (c < CONSTANTS.CONF_THRESHOLD) continue;
    const axis = AXES[i];
    const v = r.phi[i];
    const strength =
      Math.abs(v) < 0.5 ? 'typical' : Math.abs(v) < 1.5 ? 'somewhat' : Math.abs(v) < 2.3 ? 'notably' : 'extremely';
    const dir = v >= 0 ? axis.high : axis.low;
    out.push({
      line: `  ${axis.label.padEnd(26)} ${strength} ${dir}`.padEnd(64) + `conf ${c.toFixed(2)}`,
      conf: c,
    });
  }
  return out.sort((a, b) => b.conf - a.conf).map((o) => o.line);
}

async function main(): Promise<void> {
  const want = Number(process.argv[2] ?? CORPUS.verifiedPoolTarget);

  const extractCp = new Checkpoint<ExtractionResult>('extractions');
  const menuCp = new Checkpoint<MenuFetchResult>('menus');
  if (extractCp.size === 0) {
    console.error('No extractions found. Run scripts/corpus/run.ts first.');
    process.exit(1);
  }

  const itemByKey = new Map<string, MenuItem>();
  for (const m of menuCp.all()) for (const it of m.items) itemByKey.set(it.key, it);

  const verdictPath = join(PATHS.checkpoints, 'verified.json');
  mkdirSync(PATHS.checkpoints, { recursive: true });
  const prior: Verdict[] = existsSync(verdictPath)
    ? (JSON.parse(readFileSync(verdictPath, 'utf8')) as Verdict[])
    : [];
  const seen = new Set(prior.map((v) => v.key));

  // Bias toward confident extractions: those are the ones worth auditing.
  const pool = extractCp
    .all()
    .filter((r) => !seen.has(r.key) && !r.abstainedEntirely)
    .map((r) => ({ r, confident: AXIS_COUNT - r.maskedAxes.length }))
    .sort((a, b) => b.confident - a.confident)
    .slice(0, want * 3);

  // Spread across the confident band so the pool is not 200 near-identical dishes.
  const step = Math.max(1, Math.floor(pool.length / want));
  const sample = pool.filter((_, i) => i % step === 0).slice(0, want);

  console.log(`\nVerifying ${sample.length} dishes. ${prior.length} already done.`);
  console.log('y = correct, n = wrong, f = wrong on specific axes, s = skip, q = save and quit\n');

  const rl = createInterface({ input: stdin, output: stdout });
  const verdicts: Verdict[] = [...prior];

  for (let i = 0; i < sample.length; i++) {
    const { r } = sample[i];
    const item = itemByKey.get(r.key);
    console.log(`\n[${i + 1}/${sample.length}] ${item?.name ?? r.key}`);
    if (item?.description) console.log(`  "${item.description}"`);
    console.log('');
    for (const line of asWords(r)) console.log(line);

    const ans = (await rl.question('\n  y/n/f/s/q > ')).trim().toLowerCase();
    if (ans === 'q') break;
    if (ans === 's') continue;

    let wrongAxes: string[] = [];
    if (ans === 'f') {
      const which = await rl.question('  which axis labels are wrong (comma separated) > ');
      wrongAxes = which.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (ans === 'n') {
      wrongAxes = ['<all>'];
    }

    verdicts.push({
      key: r.key,
      verdict: ans === 'y' ? 'correct' : ans === 'f' ? 'fixed' : 'wrong',
      wrongAxes,
      at: new Date().toISOString(),
    });
    writeFileSync(verdictPath, JSON.stringify(verdicts, null, 2));
  }

  rl.close();

  const judged = verdicts.filter((v) => v.verdict !== 'fixed' || v.wrongAxes.length > 0);
  const correct = verdicts.filter((v) => v.verdict === 'correct').length;
  const accuracy = judged.length === 0 ? 0 : correct / judged.length;

  console.log(`\n--- diagnostic pool ---`);
  console.log(`verified dishes      ${verdicts.length}`);
  console.log(`extraction accuracy  ${(accuracy * 100).toFixed(1)}%`);
  console.log(
    accuracy >= 0.9
      ? 'PASS: clears the 90% gate. This pool is safe to fit on.'
      : `FAIL: below the 90% gate. Fix the extraction prompt before fitting, ` +
          `a bad corpus poisons every theta downstream.`,
  );
  console.log(`\nsaved to ${verdictPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
