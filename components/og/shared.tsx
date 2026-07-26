/**
 * Shared pieces for dynamically generated Open Graph images.
 *
 * These are what the product actually looks like inside a message bubble, so
 * they follow the same rules as the screens: dark page, editorial serif, mono
 * labels, dish first, no enthusiasm markers, no numbers about people.
 *
 * Satori (behind next/og) supports a subset of CSS. Everything here is flex
 * with explicit display, no shorthand backgrounds, no CSS variables.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

export const PAGE = "#0a0a0b";
export const INK = "#ece7dd";
export const INK_DIM = "#a29c92";
export const INK_FAINT = "#6c6862";
export const RULE = "#2a2925";
export const EMBER = "#d2552e";

const TONES = ["#341f1a", "#232b1c", "#2b1e2c", "#33290f", "#152628", "#2f1a16"];

export function ogTone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return TONES[h % TONES.length];
}

export async function ogFonts() {
  const [serif, mono] = await Promise.all([
    readFile(join(process.cwd(), "public/fonts/Newsreader-Regular.ttf")),
    readFile(join(process.cwd(), "public/fonts/IBMPlexMono-Regular.ttf")),
  ]);
  return [
    { name: "Newsreader", data: serif, style: "normal" as const, weight: 400 as const },
    { name: "PlexMono", data: mono, style: "normal" as const, weight: 400 as const },
  ];
}

export const labelStyle = {
  fontFamily: "PlexMono",
  fontSize: 20,
  letterSpacing: 3,
  textTransform: "uppercase" as const,
  color: INK_FAINT,
};

/** Masthead row, identical across every generated card. */
export function OgHeader({ right }: { right: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "38px 48px 0",
      }}
    >
      <div style={{ ...labelStyle, color: INK_DIM }}>Taste Twins</div>
      <div style={labelStyle}>{right}</div>
    </div>
  );
}

/** One dish panel. Dish name is the headline; the venue is secondary. */
export function OgDishPanel({
  dishId,
  name,
  venueName,
}: {
  dishId: string;
  name: string;
  venueName: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        flex: 1,
        height: "100%",
        padding: "36px 34px",
        backgroundColor: ogTone(dishId),
        border: `1px solid ${RULE}`,
      }}
    >
      <div style={{ ...labelStyle, color: INK_DIM }}>{venueName}</div>
      <div
        style={{
          fontFamily: "Newsreader",
          fontSize: name.length > 22 ? 54 : 68,
          lineHeight: 1.02,
          letterSpacing: -1,
          color: INK,
        }}
      >
        {name}
      </div>
    </div>
  );
}

export function OgFooter({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0 48px 40px",
      }}
    >
      <div style={labelStyle}>{text}</div>
      <div style={{ ...labelStyle, color: EMBER }}>no app, no account</div>
    </div>
  );
}
