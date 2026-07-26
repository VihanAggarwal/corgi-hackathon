/**
 * Live voice check for the renderer. Track A diagnostic, not part of the app.
 *
 *   npx tsx scripts/corpus/live-voice-check.ts
 *
 * Renders real packets against the live model and runs each result through the
 * production validator. Dry run proves the validator works; this proves the
 * MODEL clears it, which is a different question and the only one that matters
 * for whether the product sounds like a person.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import type { EvidencePacket } from '../../contracts/types';
import { renderRecommendation, validateRendering } from '../../core/render';
import { hasModelCredentials } from '../../core/anthropic-client';

/** Twin-sourced, with a divergence and a real caveat. The target voice case. */
const TWIN_PACKET: EvidencePacket = {
  userAxes: [
    { axis: 'sweetness_savory', label: 'sweetness in savory food', value: -2.1, percentile: 4 },
    { axis: 'acid', label: 'acidity', value: 1.8, percentile: 88 },
  ],
  dish: {
    name: 'liang pi',
    venueName: 'Hunan Slurp',
    neighborhood: 'East Village',
    priceCents: 1400,
    phiConfidence: 'high',
  },
  twinSupport: {
    n: 6,
    lift: 0.34,
    kFloorMet: true,
    clusterDescriptor: 'people who, like you, will not accept sweetness in savory food',
  },
  populationBaseline: { topDishName: 'noodles', topDishShare: 0.61 },
  caveats: [{ source: 'twin_note', n: 2, claim: 'served cold, unexpected' }],
  sourceChannel: 'twin',
  confidence: 'medium',
  constraintsAppliedCount: 0,
};

/** Content-sourced. The validator must refuse ANY twin language here. */
const CONTENT_PACKET: EvidencePacket = {
  userAxes: [
    { axis: 'char_smoke', label: 'char and smoke', value: 2.2, percentile: 94 },
    { axis: 'fat_richness', label: 'richness', value: 1.1, percentile: 71 },
  ],
  dish: {
    name: 'lamb shoulder',
    venueName: 'Ember House',
    neighborhood: 'Lower East Side',
    priceCents: 4200,
    phiConfidence: 'high',
  },
  populationBaseline: { topDishName: 'burger', topDishShare: 0.48 },
  caveats: [{ source: 'venue_data', n: 1, claim: 'forty minute wait after seven' }],
  sourceChannel: 'content',
  confidence: 'high',
  constraintsAppliedCount: 3,
};

/** Low confidence and no baseline. Output must hedge rather than bluff. */
const THIN_PACKET: EvidencePacket = {
  userAxes: [{ axis: 'funk_ferment', label: 'ferment and funk', value: 1.4, percentile: 82 }],
  dish: {
    name: 'natto toast',
    venueName: 'Kome',
    neighborhood: 'Lower East Side',
    priceCents: 900,
    phiConfidence: 'low',
  },
  caveats: [],
  expansion: { outsideRegion: true, axis: 'funk_ferment', distance: 'adjacent' },
  sourceChannel: 'content',
  confidence: 'low',
  constraintsAppliedCount: 0,
};

const CASES: Array<{ name: string; packet: EvidencePacket }> = [
  { name: 'twin channel, divergent, with caveat', packet: TWIN_PACKET },
  { name: 'content channel, no twins allowed', packet: CONTENT_PACKET },
  { name: 'low confidence, must hedge', packet: THIN_PACKET },
];

async function main(): Promise<void> {
  if (!hasModelCredentials()) {
    console.error('No ANTHROPIC_API_KEY or MERGE_GATEWAY_BASE_URL. Nothing to check.');
    process.exit(1);
  }

  console.log('\nLive voice check. Each rendering runs through the production validator.\n');

  let failures = 0;

  for (const { name, packet } of CASES) {
    console.log(`--- ${name}`);
    try {
      const result = await renderRecommendation(packet);
      console.log(`  ${result.text}\n`);

      const verdict = validateRendering(result.text, packet);
      if (verdict.ok) {
        console.log('  validator: PASS');
      } else {
        failures++;
        console.log('  validator: FAIL');
        for (const v of verdict.violations) {
          console.log(`    - ${v.code}: ${v.detail ?? ''}`);
        }
      }

      // Independent spot checks the validator may not own.
      const sentences = result.text.split(/[.!?]+\s/).filter(Boolean).length;
      console.log(`  sentences: ${sentences}`);
      if (packet.twinSupport === undefined && /\btwin/i.test(result.text)) {
        failures++;
        console.log('    - LEAK: twin language with no twinSupport');
      }
      if (/[!]|[\u{1F300}-\u{1FAFF}]/u.test(result.text)) {
        failures++;
        console.log('    - LEAK: enthusiasm marker');
      }
    } catch (err) {
      failures++;
      console.log(`  THREW: ${(err as Error).message}`);
    }
    console.log('');
  }

  if (failures > 0) {
    console.log(`${failures} problem(s). The model is not reliably clearing the rules.\n`);
    process.exit(1);
  }
  console.log('All renderings cleared the validator.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
