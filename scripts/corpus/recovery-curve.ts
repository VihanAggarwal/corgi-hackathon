/**
 * Prints the theta recovery curve. Track A diagnostic, not part of the app.
 *
 *   npx tsx scripts/corpus/recovery-curve.ts
 *
 * Answers the question the build spec gates on: how many duels before a user's
 * fitted vector actually points where their true taste points.
 */

import { AXIS_COUNT } from '../../contracts/axes';
import { fitTheta, type FitObservation } from '../../core/model';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function cosine(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < AXIS_COUNT; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function truth(): number[] {
  const t = new Array(AXIS_COUNT).fill(0);
  t[0] = 2.0;
  t[4] = -2.4;
  t[9] = 1.6;
  t[21] = -1.2;
  return t;
}

function duels(trueTheta: number[], count: number, seed: number): FitObservation[] {
  const rand = rng(seed);
  const out: FitObservation[] = [];
  for (let i = 0; i < count; i++) {
    const a = Array.from({ length: AXIS_COUNT }, () => (rand() - 0.5) * 4);
    const b = Array.from({ length: AXIS_COUNT }, () => (rand() - 0.5) * 4);
    let z = 0;
    for (let j = 0; j < AXIS_COUNT; j++) z += trueTheta[j] * (a[j] - b[j]);
    const aWins = rand() < 1 / (1 + Math.exp(-z));
    out.push({ winnerPhi: aWins ? a : b, loserPhi: aWins ? b : a });
  }
  return out;
}

const T = truth();
const TRIALS = 40;

console.log('\nTheta recovery. Synthetic user picks probabilistically, not argmax.');
console.log('Mean over 40 seeds. Cosine is direction; magnitude is shrunk on purpose.\n');
console.log('  duels   cosine to truth   posterior var   stable?');

for (const n of [5, 10, 12, 15, 20, 30, 50, 100, 200]) {
  let cos = 0;
  let pv = 0;
  for (let s = 0; s < TRIALS; s++) {
    const fit = fitTheta(duels(T, n, s * 977 + 1), { lambda: 6 });
    cos += cosine(fit.theta, T);
    pv += fit.posteriorVar;
  }
  cos /= TRIALS;
  pv /= TRIALS;
  const stable = n >= 12 && pv <= 0.35;
  console.log(
    `  ${String(n).padStart(5)}   ${cos.toFixed(3).padStart(13)}   ${pv
      .toFixed(4)
      .padStart(13)}   ${stable ? 'yes' : 'no'}`,
  );
}
console.log('');
