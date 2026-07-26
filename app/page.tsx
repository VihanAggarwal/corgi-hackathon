import Link from "next/link";
import { Label, Masthead, Rule, Screen } from "@/components/ui/primitives";

export default function Home() {
  return (
    <>
      <Masthead />
      <Screen className="flex flex-col justify-between pb-10">
        <div className="pt-10 sm:pt-20">
          <h1 className="display text-[3.25rem] sm:text-[5.5rem] max-w-[30ch]">
            Two dishes.
            <br />
            Pick one.
          </h1>
          <p className="prose-page mt-8 max-w-[38ch] text-ink-dim">
            Twelve of those and this can tell you something true about how you
            eat, including one part you will not enjoy reading.
          </p>
        </div>

        <div className="mt-16">
          <Rule />
          <Link
            href="/duel"
            className="group flex items-baseline justify-between py-6 border-b border-rule hover:border-rule-bright transition-colors"
          >
            <span className="display text-[2rem] sm:text-[2.5rem]">
              First duel
            </span>
            <Label bright>no account, no install</Label>
          </Link>
          <p className="pt-6 max-w-[46ch] text-[0.95rem] leading-snug text-ink-faint">
            The unit here is the dish, not the restaurant. Nothing is scored out
            of five, and no number about a person is displayed anywhere in this
            product.
          </p>
        </div>
      </Screen>
    </>
  );
}
