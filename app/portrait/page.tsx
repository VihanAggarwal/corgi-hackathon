import {
  IS_SEEDED,
  getDishView,
  getPortrait,
  getRecommendations,
  getRegionStates,
} from "@/components/data";
import { RecommendationCard } from "@/components/rec/RecommendationCard";
import { RegionShape } from "@/components/portrait/RegionShape";
import { Label, Masthead, Rule, SeededBadge } from "@/components/ui/primitives";
import { ShareRow } from "@/components/ui/ShareRow";
import { AXES, type AxisKey } from "@/contracts/axes";

export const metadata = {
  title: "Palate portrait — Taste Twins",
  description: "Taste, rendered as language rather than as a chart.",
};

const axisLabel = (key: AxisKey) =>
  AXES.find((a) => a.key === key)?.label ?? key;

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const dateLine = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

/**
 * The best-looking screen in the app, and the one that has to survive being
 * screenshotted into a thread. Treated as a printed page: one column, one
 * measure, no dashboard furniture. No radar chart, no axis sliders, no numbers.
 *
 * The prose comes from Track A. Track B sets it and does not paraphrase it.
 */
export default async function PortraitPage() {
  const [portrait, { before, after }, recs] = await Promise.all([
    getPortrait(),
    getRegionStates(),
    getRecommendations(),
  ]);

  // The twin channel may be off, in which case getRecommendations never hands
  // back a twin card and nothing on this page mentions one.
  const next = recs[0] ?? null;
  const nextDish = next ? await getDishView(next.dishId) : null;

  const paragraphs = portrait.body.split("\n\n");
  const gained = after.exploredAxes
    .filter((a) => !before.exploredAxes.includes(a))
    .map(axisLabel);
  const frontier = after.frontierAxes.map(axisLabel);

  return (
    <>
      <Masthead right={<Label>{dateLine(portrait.generatedAt)}</Label>} />

      <main className="flex-1 w-full max-w-[46rem] mx-auto px-6 sm:px-10 pb-20">
        {/* The portrait and the two-week region are fixtures until the swap.
            A reader who just played twelve duels would otherwise take the
            history below as their own. */}
        <div className="pt-6 flex items-baseline justify-between gap-4">
          <Label bright>palate portrait</Label>
          {IS_SEEDED ? <SeededBadge /> : null}
        </div>

        <h1 className="sr-only">Palate portrait</h1>

        {/* The opening line is set as the headline. It is not rewritten, not
            summarised, and no line of display copy is invented on top of it:
            every sentence on this screen came out of the generator. */}
        <article className="mt-6 ink-in">
          <p className="display text-[1.75rem] sm:text-[2.5rem] leading-[1.22] max-w-[30ch]">
            {paragraphs[0]}
          </p>

          <Rule className="mt-10" />

          <div className="mt-9 flex flex-col gap-7">
            {paragraphs.slice(1).map((p, i) => (
              <p key={i} className="prose-page">
                {p}
              </p>
            ))}
          </div>
        </article>

        <Rule className="mt-12" />

        {/* Palate volume, as prose and as one shape in two states. Everything
            said here is read off PalateRegion; none of it is embellished. */}
        <section className="mt-10 flex flex-col sm:flex-row gap-10 items-start">
          <div className="flex-1">
            <p className="prose-page">
              Your region is wider than it was two weeks ago. You have eaten
              into {list(gained)}, which are directions you had never gone.
            </p>
            <p className="prose-page mt-6 text-ink-dim">
              Still blank: {list(frontier)}. The next thing worth ordering sits
              on the edge of one of those, not in the middle of what you already
              like.
            </p>
          </div>
          <RegionShape
            before={before}
            after={after}
            caption="the region you have eaten in"
          />
        </section>

        {next ? (
          <section className="mt-14">
            <Rule />
            <p className="pt-9 pb-7">
              <Label bright>the one just past the edge</Label>
            </p>
            <RecommendationCard rec={next} dish={nextDish} compact />
          </section>
        ) : null}

        <div className="mt-14">
          <ShareRow
            path="/c/k3n7q"
            label="Send someone two dishes"
            text="Two dishes. Pick one."
          />
        </div>
      </main>
    </>
  );
}
