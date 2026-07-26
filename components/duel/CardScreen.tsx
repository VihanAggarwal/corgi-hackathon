"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { ComparisonResult } from "@/contracts/types";
import { getComparison, getTwinStatus, type DuelPairView } from "@/components/data";
import { DuelFeed } from "@/components/duel/DuelFeed";
import { ComparisonView } from "@/components/comparison/ComparisonView";
import { Label, Masthead, Rule } from "@/components/ui/primitives";
import { ShareRow } from "@/components/ui/ShareRow";

/** How many the recipient plays before the comparison is honest enough to show. */
const CARD_TARGET = 10;

/**
 * The pasted link. This is the growth loop, so it obeys three rules:
 * playable in one tap, no account, and nothing loads before the first duel.
 * The pair from the message is the first duel, already on screen.
 */
export function CardScreen({
  cardId,
  senderFirstName,
  senderPickedDishId,
  senderPickedName,
  pairs,
}: {
  cardId: string;
  senderFirstName: string;
  senderPickedDishId: string;
  senderPickedName: string;
  pairs: DuelPairView[];
}) {
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [twinLanguage, setTwinLanguage] = useState(false);

  const onPick = useCallback((index: number) => {
    if (index === 0) setRevealed(true);
  }, []);

  const onComplete = useCallback(async () => {
    const [comparison, twins] = await Promise.all([
      getComparison(cardId),
      getTwinStatus(),
    ]);
    setTwinLanguage(twins.enabled);
    setResult(comparison);
  }, [cardId]);

  if (result) {
    return (
      <>
        <Masthead right={<Label>{senderFirstName} sent this</Label>} />
        <main className="flex-1 w-full max-w-[54rem] mx-auto px-6 sm:px-10 pt-4 pb-14">
          <ComparisonView
            result={result}
            otherName={senderFirstName}
            duelCount={CARD_TARGET}
            twinLanguage={twinLanguage}
            footer={
              <>
                <ShareRow
                  path="/c/m8x2v"
                  label="Send two dishes to someone else"
                  text="Two dishes. Pick one."
                />
                <Link
                  href="/portrait"
                  className="flex items-baseline justify-between py-6 border-b border-rule hover:border-rule-bright transition-colors"
                >
                  <span className="display text-[1.75rem] sm:text-[2.25rem]">
                    What your ten picks say about you
                  </span>
                  <Label bright>read it</Label>
                </Link>
              </>
            }
          />
        </main>
      </>
    );
  }

  return (
    <>
      <Masthead right={<Label>{senderFirstName} sent this</Label>} />
      <main className="flex-1 min-h-0 w-full max-w-[54rem] mx-auto px-6 sm:px-10 flex flex-col">
        {revealed ? (
          <div className="pb-3">
            <Rule className="mb-3" />
            <Label bright>
              {senderFirstName} picked the {senderPickedName.toLowerCase()}
            </Label>
          </div>
        ) : null}

        <DuelFeed
          pairs={pairs}
          target={CARD_TARGET}
          surface="imessage"
          onPick={onPick}
          onComplete={onComplete}
          prompt={`${senderFirstName} picked one of these two. Pick yours, and nine more, and you will find out whether the two of you eat the same way. Probably not.`}
        />

        {/* senderPickedDishId is carried for the integration pass, where the
            comparison is computed against the sender's actual pick. */}
        <span className="hidden" data-sender-pick={senderPickedDishId} />
      </main>
    </>
  );
}
