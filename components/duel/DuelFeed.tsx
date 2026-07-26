"use client";

import { useCallback, useMemo, useState } from "react";
import type { DuelPairView } from "@/components/data";
import { submitDuel } from "@/components/data";
import { appendPick, deviceId } from "@/components/lib/device";
import { DishCard } from "@/components/duel/DishCard";
import { Label } from "@/components/ui/primitives";

/**
 * The duel feed.
 *
 * Speed is the whole design. The block of pairs is already in memory, the next
 * pair's photos are preloaded, the write is fire-and-forget, and the index
 * advances in the same tick as the tap. There is no spinner between duels and
 * no await on the interaction path.
 *
 * Progress is implicit: a hairline that fills. Never "step 4 of 15", because
 * counting steps turns a game into a form.
 */
export function DuelFeed({
  pairs,
  target,
  surface,
  onComplete,
  onPick,
  prompt,
}: {
  pairs: DuelPairView[];
  /** how many picks before the parent takes over */
  target: number;
  surface: "feed" | "imessage" | "agent" | "demo";
  onComplete: (count: number) => void;
  /** every pick, in order. Used by the share card to reveal the sender's pick. */
  onPick?: (index: number, winner: string) => void;
  /** shown on the first pair only. There is no onboarding, only the first duel. */
  prompt?: string;
}) {
  const [index, setIndex] = useState(0);
  const [pickedId, setPickedId] = useState<string | null>(null);
  /**
   * Skips are counted separately and NEVER count toward the target.
   *
   * "I have not heard of either of these" is real information about the corpus
   * and zero information about the person's taste. Letting it advance the
   * progress bar would let someone reach a finished profile having taught the
   * model nothing, which is worse than making them swipe two more pairs.
   */
  const [skipped, setSkipped] = useState(0);

  const pair = pairs[index % pairs.length];
  const next = pairs[(index + 1) % pairs.length];

  const preload = useMemo(
    () => [next?.a.imageUrl, next?.b.imageUrl].filter(Boolean) as string[],
    [next],
  );

  const pick = useCallback(
    (winner: string) => {
      if (pickedId) return;
      setPickedId(winner);
      onPick?.(index, winner);

      appendPick({
        dishA: pair.a.dishId,
        dishB: pair.b.dishId,
        winner,
        at: Date.now(),
      });

      // Not awaited. A duel never waits on a round trip.
      void submitDuel({
        deviceId: deviceId(),
        dishA: pair.a.dishId,
        dishB: pair.b.dishId,
        winner,
        surface,
      });

      // Counted for this run only, and skips do not count. appendPick returns a
      // lifetime total, so a second visit cleared the target on its first tap:
      // the recipient of a shared card saw a comparison that claimed ten picks
      // after making one.
      const picks = index + 1 - skipped;
      if (picks >= target) {
        onComplete(picks);
        return;
      }

      // One frame of acknowledgement, then the next pair. Nothing loads.
      window.setTimeout(() => {
        setPickedId(null);
        setIndex((i) => i + 1);
      }, 130);
    },
    [index, onComplete, onPick, pair, pickedId, skipped, surface, target],
  );

  /**
   * Advance without recording anything.
   *
   * Deliberately does not call submitDuel: a skip is not a duel with a missing
   * winner, it is the absence of an observation. Sending it would put a
   * meaningless row in front of the model fit.
   */
  const skip = useCallback(() => {
    if (pickedId) return;
    setSkipped((s) => s + 1);
    setIndex((i) => i + 1);
  }, [pickedId]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {preload.map((src) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={src} src={src} alt="" aria-hidden className="hidden" />
      ))}

      {index === 0 && prompt ? (
        <p className="pb-4 text-ink-dim text-[1.0625rem] leading-snug">
          {prompt}
        </p>
      ) : null}

      <div
        key={pair.pairId}
        className="flex-1 min-h-0 grid grid-rows-2 sm:grid-rows-1 sm:grid-cols-2 gap-3"
      >
        <DishCard
          dish={pair.a}
          onPick={pick}
          eager={index === 0}
          picked={pickedId === pair.a.dishId}
          dimmed={pickedId != null && pickedId !== pair.a.dishId}
        />
        <DishCard
          dish={pair.b}
          onPick={pick}
          eager={index === 0}
          picked={pickedId === pair.b.dishId}
          dimmed={pickedId != null && pickedId !== pair.b.dishId}
        />
      </div>

      <div className="pt-4 pb-6 flex items-center gap-4">
        <div className="flex-1 h-px bg-rule relative">
          <div
            className="absolute left-0 top-0 h-px bg-ink/70 transition-[width] duration-200"
            style={{
              width: `${Math.min(100, ((index - skipped) / target) * 100)}%`,
            }}
          />
        </div>

        {/* Understated on purpose. Skipping is allowed, not encouraged: every
            skip is a pair that taught the model nothing. */}
        <button
          type="button"
          onClick={skip}
          disabled={pickedId != null}
          className="label text-ink-faint hover:text-ink-dim transition-colors disabled:opacity-40"
        >
          dont know either
        </button>

        <Label>
          {index === 0 ? "tap the one you would rather eat" : "keep going"}
        </Label>
      </div>
    </div>
  );
}
