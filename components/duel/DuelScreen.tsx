"use client";

import Link from "next/link";
import { useState } from "react";
import type { DuelPairView } from "@/components/data";
import { DuelFeed } from "@/components/duel/DuelFeed";
import { Label, Masthead, Rule } from "@/components/ui/primitives";
import { CONSTANTS } from "@/contracts/types";

export function DuelScreen({ pairs }: { pairs: DuelPairView[] }) {
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <>
        <Masthead right={<Label>enough to read you</Label>} />
        <main className="flex-1 w-full max-w-[54rem] mx-auto px-6 sm:px-10 flex flex-col justify-center pb-16 ink-in">
          <h1 className="display text-[2.75rem] sm:text-[4rem] max-w-[24ch]">
            That is enough to say something.
          </h1>
          <p className="prose-page mt-6 max-w-[42ch] text-ink-dim">
            Twelve picks is where the shape stops moving much. What follows is
            written from those picks and nothing else.
          </p>
          <div className="mt-12">
            <Rule />
            <Link
              href="/portrait"
              className="flex items-baseline justify-between py-6 border-b border-rule hover:border-rule-bright transition-colors"
            >
              <span className="display text-[1.75rem] sm:text-[2.25rem]">
                Your palate portrait
              </span>
              <Label bright>read it</Label>
            </Link>
            <button
              type="button"
              onClick={() => setDone(false)}
              className="pt-6 label hover:text-ink-dim transition-colors"
            >
              keep dueling instead
            </button>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Masthead />
      <main className="flex-1 min-h-0 w-full max-w-[54rem] mx-auto px-6 sm:px-10 flex flex-col">
        <DuelFeed
          pairs={pairs}
          target={CONSTANTS.MIN_DUELS_FOR_THETA}
          surface="feed"
          onComplete={() => setDone(true)}
          prompt="Both of these are real, both are good, and one of them is more you than the other."
        />
      </main>
    </>
  );
}
