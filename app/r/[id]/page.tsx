import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDishView, getRecommendation } from "@/components/data";
import { RecommendationCard } from "@/components/rec/RecommendationCard";
import { Label, Masthead, Rule } from "@/components/ui/primitives";
import { ShareRow } from "@/components/ui/ShareRow";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const rec = await getRecommendation(id);
  if (!rec) return { title: "Taste Twins" };

  const dish = await getDishView(rec.dishId);
  const title = dish ? `${dish.name}, ${dish.venueName}` : "A dish worth ordering";
  const description = rec.text;

  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** A recommendation, pasteable into any thread. Same treatment as the duel card. */
export default async function RecommendationPage({ params }: Props) {
  const { id } = await params;
  const rec = await getRecommendation(id);
  if (!rec) notFound();

  const dish = await getDishView(rec.dishId);

  return (
    <>
      <Masthead right={<Label>one dish</Label>} />
      <main className="flex-1 w-full max-w-[54rem] mx-auto px-6 sm:px-10 pt-8 pb-16 flex flex-col justify-between">
        <RecommendationCard rec={rec} dish={dish} />

        <div className="mt-16">
          <ShareRow
            path={`/r/${rec.packetId}`}
            label="Send this to whoever you eat with"
            text={rec.text}
          />
          <Link
            href="/duel"
            className="flex items-baseline justify-between py-6 border-b border-rule hover:border-rule-bright transition-colors"
          >
            <span className="display text-[1.75rem] sm:text-[2.25rem]">
              Get your own read
            </span>
            <Label bright>two dishes, pick one</Label>
          </Link>
          <Rule className="opacity-0" />
        </div>
      </main>
    </>
  );
}
