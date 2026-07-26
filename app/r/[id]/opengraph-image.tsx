import { ImageResponse } from "next/og";
import { getDishView, getRecommendation } from "@/components/data";
import {
  INK,
  INK_DIM,
  OG_CONTENT_TYPE,
  OG_SIZE,
  OgFooter,
  OgHeader,
  PAGE,
  labelStyle,
  ogFonts,
  ogTone,
} from "@/components/og/shared";

export const alt = "A dish worth ordering";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/**
 * Dish name is the headline, venue is secondary, and the source channel is
 * stated on the card. The reason text is trimmed rather than rewritten.
 */
export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const rec = await getRecommendation(id);
  const dish = await getDishView(rec?.dishId ?? null);
  const fonts = await ogFonts();

  const channelLabel =
    rec?.sourceChannel === "twin"
      ? "from people who taste like you"
      : rec?.sourceChannel === "agent_vision"
        ? "read off a menu"
        : "from your own picks";

  const reason = rec ? firstSentences(rec.text, 2) : "";

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
        <OgHeader right={channelLabel} />

        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            justifyContent: "space-between",
            margin: "28px 48px 30px",
            padding: "40px 44px",
            backgroundColor: dish ? ogTone(dish.dishId) : "#121213",
            border: "1px solid #2a2925",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                fontFamily: "Newsreader",
                fontSize: 76,
                lineHeight: 1.02,
                letterSpacing: -1.5,
                color: INK,
              }}
            >
              {dish?.name ?? "One dish"}
            </div>
            <div style={{ ...labelStyle, color: INK_DIM, marginTop: 18 }}>
              {dish ? `${dish.venueName} — ${dish.neighborhood}` : ""}
            </div>
          </div>

          <div
            style={{
              fontFamily: "Newsreader",
              fontSize: 30,
              lineHeight: 1.4,
              color: INK_DIM,
              maxWidth: 900,
            }}
          >
            {reason}
          </div>
        </div>

        <OgFooter text="one dish, one reason" />
      </div>
    ),
    { ...size, fonts },
  );
}

/** Trim, never rewrite: the sentences shown are the generator's own. */
function firstSentences(text: string, n: number): string {
  const parts = text.split(/(?<=\.)\s+/);
  return parts.slice(0, n).join(" ");
}
