import { ImageResponse } from "next/og";
import { getShareCard } from "@/components/data";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  OgDishPanel,
  OgFooter,
  OgHeader,
  PAGE,
  ogFonts,
} from "@/components/og/shared";

export const alt = "Two dishes. Pick one.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/**
 * The image that appears in the message bubble. This is the growth loop: if
 * this looks like a real card, the link gets tapped, and if it looks like a
 * generic link preview, none of the rest of the product happens.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ cardId: string }>;
}) {
  const { cardId } = await params;
  const share = await getShareCard(cardId);
  const fonts = await ogFonts();

  const a = share?.card.a;
  const b = share?.card.b;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: PAGE,
        }}
      >
        <OgHeader right={share ? `${share.senderFirstName} sent this` : "duel"} />

        <div
          style={{
            display: "flex",
            flex: 1,
            gap: 14,
            padding: "28px 48px 30px",
          }}
        >
          {a ? (
            <OgDishPanel dishId={a.dishId} name={a.name} venueName={a.venueName} />
          ) : null}
          {b ? (
            <OgDishPanel dishId={b.dishId} name={b.name} venueName={b.venueName} />
          ) : null}
        </div>

        <OgFooter text="two dishes, pick one" />
      </div>
    ),
    { ...size, fonts },
  );
}
