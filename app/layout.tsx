import type { Metadata, Viewport } from "next";
import { Newsreader, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "500"],
  style: ["normal", "italic"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500"],
});

/**
 * Absolute origin for Open Graph image URLs.
 *
 * This matters more than it looks. iMessage fetches og:image from a server that
 * is not the user's phone, so a relative or localhost URL produces no rich card
 * at all: the thread shows a bare blue link and the entire growth loop silently
 * disappears. It fails only in a real thread, never in local dev or a preview
 * tool, which is the worst possible place to find out.
 *
 * So we do not depend on someone remembering to set NEXT_PUBLIC_SITE_URL.
 * Vercel injects its own deployment host, and we fall back to that before ever
 * falling back to localhost.
 */
function resolveOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.startsWith("http") ? explicit : `https://${explicit}`;

  // Stable production domain, then the per-deployment URL.
  const vercel =
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.NEXT_PUBLIC_VERCEL_URL ??
    process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;

  return "http://localhost:3000";
}

export const metadata: Metadata = {
  title: "Taste Twins",
  description:
    "Two dishes. Pick one. Twelve of those and it can say something true about how you eat.",
  metadataBase: new URL(resolveOrigin()),
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
