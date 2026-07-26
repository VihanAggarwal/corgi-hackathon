/**
 * Does the quiz actually distinguish people now?
 *
 *   npx tsx scripts/corpus/palate-spread.ts
 *
 * The bug: everyone came out an "acid person". The suspected cause was sparse
 * dish vectors, where most axes were 0 on every dish and so could never move.
 * This measures whether that is fixed, rather than assuming it.
 *
 * Method: simulate distinct synthetic people, each with a different true
 * palate, run them through real duels from the corpus, fit theta, and report
 * which axis each one ends up strongest on. If the corpus can distinguish
 * palates, different people land on different axes.
 */

import { AXES, AXIS_COUNT } from '../../contracts/axes';
import { fitTheta, type FitObservation } from '../../core';
import { DISHES } from '../../lib/store/corpus';
import { CONSTANTS } from '../../contracts/types';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

/** Six very different people, each defined by one strong preference. */
const PEOPLE: Array<{ name: string; axis: number; dir: number }> = [
  { name: 'chili head', axis: 0, dir: 1 },
  { name: 'acid lover', axis: 2, dir: 1 },
  { name: 'rich and fatty', axis: 6, dir: 1 },
  { name: 'funk seeker', axis: 9, dir: 1 },
  { name: 'crunch texture', axis: 14, dir: 1 },
  { name: 'vegetable led', axis: 19, dir: -1 },
];

const verified = DISHES.filter((d) => d.verified);
const density =
  DISHES.reduce(
    (s, d) => s + d.vector.confidence.filter((c) => c >= CONSTANTS.CONF_THRESHOLD).length,
    0,
  ) / DISHES.length;

console.log(`\ncorpus: ${DISHES.length} dishes, mean ${density.toFixed(1)}/24 confident axes\n`);
console.log('  person             strongest fitted axis');

const landed = new Set<string>();

for (const p of PEOPLE) {
  const truth = new Array(AXIS_COUNT).fill(0);
  truth[p.axis] = 2.2 * p.dir;

  const rand = rng(p.axis * 7919 + 13);
  const obs: FitObservation[] = [];

  // Twelve duels, the length of a real calibration session.
  for (let i = 0; i < 12; i++) {
    const a = verified[Math.floor(rand() * verified.length)];
    const b = verified[Math.floor(rand() * verified.length)];
    if (a.id === b.id) continue;
    let z = 0;
    for (let j = 0; j < AXIS_COUNT; j++) z += truth[j] * (a.vector.phi[j] - b.vector.phi[j]);
    const aWins = rand() < 1 / (1 + Math.exp(-z));
    obs.push({
      winnerPhi: aWins ? a.vector.phi : b.vector.phi,
      loserPhi: aWins ? b.vector.phi : a.vector.phi,
    });
  }

  const fit = fitTheta(obs, { lambda: 6 });
  let best = 0;
  for (let i = 1; i < AXIS_COUNT; i++) {
    if (Math.abs(fit.theta[i]) > Math.abs(fit.theta[best])) best = i;
  }
  landed.add(AXES[best].key);
  console.log(`  ${p.name.padEnd(18)} ${AXES[best].label}`);
}

console.log('');
console.log(
  landed.size >= 4
    ? `PASS: ${landed.size} distinct outcomes across 6 people. the quiz discriminates.`
    : `FAIL: only ${landed.size} distinct outcomes. still collapsing onto the same axes.`,
);
console.log('');
