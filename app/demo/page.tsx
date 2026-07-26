import { headers } from "next/headers";
import QRCode from "qrcode";
import { getDemoCardId, getDemoEvents } from "@/components/data";
import { DemoFeed } from "@/components/demo/DemoFeed";
import { Label, Masthead } from "@/components/ui/primitives";

export const metadata = { title: "Demo — Taste Twins" };

/** Big enough to scan from the back of a room. */
async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0a0a0b", light: "#ece7dd" },
  });
}

async function origin(): Promise<string> {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

export default async function DemoPage() {
  const [cardId, events, base] = await Promise.all([
    getDemoCardId(),
    getDemoEvents(),
    origin(),
  ]);

  const url = `${base}/c/${cardId}`;
  const svg = await qrSvg(url);

  return (
    <>
      <Masthead right={<Label>presenter view</Label>} />
      <main className="flex-1 w-full max-w-[72rem] mx-auto px-6 sm:px-10 pb-14 flex flex-col lg:flex-row gap-12 lg:gap-16">
        <section className="lg:w-[28rem] shrink-0">
          <h1 className="display text-[2.5rem] sm:text-[3.25rem] max-w-[18ch]">
            Point your phone at this.
          </h1>
          <p className="mt-4 max-w-[34ch] text-ink-dim text-[1.0625rem] leading-snug">
            Two dishes, pick one, ten times. No install, no account, and it
            starts working on the first tap.
          </p>

          <div
            className="mt-8 w-full max-w-[24rem] bg-ink p-4"
            style={{ background: "#ece7dd" }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />

          <p className="mt-4">
            <Label bright>{url.replace(/^https?:\/\//, "")}</Label>
          </p>
        </section>

        <section className="flex-1 min-w-0">
          <DemoFeed seeded={events} />
        </section>
      </main>
    </>
  );
}
