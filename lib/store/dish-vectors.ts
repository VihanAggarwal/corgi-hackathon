/**
 * The dish vectors the model actually fits on.
 *
 * WHY A MERGE AND NOT A REPLACEMENT
 * Two sources, each with a real weakness:
 *
 *   hand written (components/mock/fixtures.ts)
 *     Only about seven of twenty four axes per dish, everything else exactly
 *     0. An axis that is 0 on every dish yields a zero difference on every
 *     duel, so fitTheta can never move it off the prior. That is why the quiz
 *     kept calling everyone an "acid person": only the few populated axes
 *     could ever move, so the profile was decided by which axes somebody
 *     filled in by hand rather than by what the person picked.
 *
 *   generated (scripts/corpus/score-fixtures.ts)
 *     Denser, and scored relative to the rest of the corpus in one pass. But
 *     the extractor is built to ABSTAIN rather than guess, and on three dishes
 *     it abstained on everything, returning 0 confident axes. Taking it
 *     wholesale would make those dishes contribute nothing at all.
 *
 * So: generated value wins on any axis it is confident about, hand written
 * fills the rest. Neither source alone is right, and the merge is strictly
 * denser than either.
 */

import { CONSTANTS, type Dish, type Vec24 } from '@/contracts/types';
import { GENERATED_VECTORS } from './dish-vectors.generated';

/**
 * Merge a dish's hand-written vector with its generated one.
 *
 * Returns a NEW dish object; the fixture is never mutated, since it is Track
 * B's file and other surfaces read it directly.
 */
export function withMergedVector(dish: Dish): Dish {
  const gen = GENERATED_VECTORS[dish.id];
  if (!gen) return dish;

  const phi: Vec24 = [...dish.vector.phi];
  const confidence = [...dish.vector.confidence];

  for (let i = 0; i < phi.length; i++) {
    const genConfident = (gen.confidence[i] ?? 0) >= CONSTANTS.CONF_THRESHOLD;
    if (genConfident) {
      // The model looked at this axis and committed to a value. Prefer it: it
      // was scored against the rest of the corpus in one pass, so the numbers
      // are comparable across dishes in a way hand written ones are not.
      phi[i] = gen.phi[i];
      confidence[i] = gen.confidence[i];
    }
    // Otherwise keep whatever was hand written, including a deliberate 0.
  }

  return {
    ...dish,
    vector: {
      phi,
      confidence,
      // Recomputed from the merged confidences rather than carried over, or a
      // mask from one source would hide a value the other was sure about.
      maskedAxes: dish.vector.maskedAxes.filter(
        (_, i) => confidence[i] < CONSTANTS.CONF_THRESHOLD,
      ),
    },
  };
}

/** How many axes this dish can actually contribute to a fit. Diagnostic. */
export function confidentAxisCount(dish: Dish): number {
  return dish.vector.confidence.filter((c) => c >= CONSTANTS.CONF_THRESHOLD).length;
}
