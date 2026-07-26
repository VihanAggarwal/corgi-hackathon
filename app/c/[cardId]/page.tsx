import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDuelBlockForCard, getShareCard } from "@/components/data";
import { CardScreen } from "@/components/duel/CardScreen";

type Props = { params: Promise<{ cardId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { cardId } = await params;
  const share = await getShareCard(cardId);
  if (!share) return { title: "Taste Twins" };

  const title = `${share.card.a.name} or ${share.card.b.name}`;
  const description = `${share.senderFirstName} picked one of these. Pick yours; ten dishes later you find out whether the two of you eat the same way.`;

  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function SharedCardPage({ params }: Props) {
  const { cardId } = await params;
  const share = await getShareCard(cardId);
  if (!share) notFound();

  const pairs = await getDuelBlockForCard(cardId);

  return (
    <CardScreen
      cardId={cardId}
      senderFirstName={share.senderFirstName}
      senderPickedDishId={share.senderPickedDishId}
      senderPickedName={
        share.card.a.dishId === share.senderPickedDishId
          ? share.card.a.name
          : share.card.b.name
      }
      pairs={pairs}
    />
  );
}
