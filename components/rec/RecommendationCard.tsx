import type { RenderedRecommendation } from "@/contracts/types";
import type { DishView } from "@/components/data";
import { Label } from "@/components/ui/primitives";

/**
 * Renders a RenderedRecommendation and nothing else. The sentence was written
 * by the renderer from an evidence packet; Track B does not add a clause, a
 * caveat, or a call to action to it.
 *
 * The channel is stated honestly and is visible at a glance: a card sourced
 * from people who taste like you cannot be mistaken for one the model produced
 * on its own. When the twin channel is off, this component is never handed a
 * twin card, so the word never appears.
 */

type Channel = RenderedRecommendation["sourceChannel"];

const CHANNEL: Record<Channel, { label: string; accent: string }> = {
  twin: { label: "from people who taste like you", accent: "#d2552e" },
  content: { label: "from your own picks only", accent: "#403e39" },
  agent_vision: { label: "read off the menu you sent", accent: "#a29c92" },
};

export function RecommendationCard({
  rec,
  dish,
  compact,
}: {
  rec: RenderedRecommendation;
  dish: DishView | null;
  compact?: boolean;
}) {
  const channel = CHANNEL[rec.sourceChannel];

  return (
    <article
      className="pl-5 sm:pl-7"
      style={{ borderLeft: `2px solid ${channel.accent}` }}
    >
      <Label bright>{channel.label}</Label>

      {dish ? (
        <>
          <h2
            className={`display mt-4 ${
              compact
                ? "text-[1.75rem] sm:text-[2.25rem]"
                : "text-[2.5rem] sm:text-[3.25rem]"
            }`}
          >
            {dish.name}
          </h2>
          <p className="mt-3 flex gap-4">
            <Label bright>{dish.venueName}</Label>
            <Label>{dish.neighborhood}</Label>
            {dish.priceCents != null ? (
              <Label>${(dish.priceCents / 100).toFixed(0)}</Label>
            ) : null}
          </p>
        </>
      ) : null}

      <p className={`prose-page mt-6 max-w-[46ch] ${compact ? "text-[1.1875rem]" : ""}`}>
        {rec.text}
      </p>
    </article>
  );
}
