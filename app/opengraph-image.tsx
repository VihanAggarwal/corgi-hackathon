import { ImageResponse } from "next/og";
import {
  INK,
  INK_DIM,
  OG_CONTENT_TYPE,
  OG_SIZE,
  OgFooter,
  OgHeader,
  PAGE,
  ogFonts,
} from "@/components/og/shared";

export const alt = "Two dishes. Pick one.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/** Fallback preview for any route without its own card. */
export default async function Image() {
  const fonts = await ogFonts();

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
        <OgHeader right="dish-level" />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            padding: "0 48px",
          }}
        >
          <div
            style={{
              fontFamily: "Newsreader",
              fontSize: 116,
              lineHeight: 0.98,
              letterSpacing: -3,
              color: INK,
            }}
          >
            Two dishes.
          </div>
          <div
            style={{
              fontFamily: "Newsreader",
              fontSize: 116,
              lineHeight: 0.98,
              letterSpacing: -3,
              color: INK,
            }}
          >
            Pick one.
          </div>
          <div
            style={{
              fontFamily: "Newsreader",
              fontSize: 32,
              lineHeight: 1.4,
              color: INK_DIM,
              marginTop: 28,
              maxWidth: 720,
            }}
          >
            Twelve of those and it can say something true about how you eat,
            including one part you will not enjoy reading.
          </div>
        </div>
        <OgFooter text="two dishes, pick one" />
      </div>
    ),
    { ...size, fonts },
  );
}
