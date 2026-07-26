"use client";

import { useEffect, useState } from "react";
import { getDemoEvents, type DemoEvent } from "@/components/data";
import { Label, SeededBadge } from "@/components/ui/primitives";

const KIND_LABEL: Record<DemoEvent["kind"], string> = {
  scan: "card opened",
  duel: "pick",
  profile_formed: "profile formed",
  comparison: "comparison",
};

/**
 * The presenter's view: scans arriving and profiles forming, live.
 *
 * Everything that came from a seed is labelled as seeded on screen. We do not
 * present fabricated history as real usage, including in the room where it
 * would be most convenient to.
 */
export function DemoFeed({ seeded }: { seeded: DemoEvent[] }) {
  const [events, setEvents] = useState<DemoEvent[]>(seeded);
  const [live, setLive] = useState<DemoEvent[]>([]);

  useEffect(() => {
    // At the integration pass this becomes a poll of Track C's activity route,
    // and anything it returns is real and therefore renders without the badge.
    const t = window.setInterval(async () => {
      const next = await getDemoEvents();
      setEvents(next);
    }, 4000);
    return () => window.clearInterval(t);
  }, []);

  // Local picks made on this device during the demo are real activity.
  useEffect(() => {
    function onStorage() {
      setLive((l) => l);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const rows = [...live, ...events];

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <Label bright>activity</Label>
        <SeededBadge />
      </div>

      <ul className="mt-5 flex flex-col">
        {rows.map((e) => (
          <li
            key={e.id}
            className="flex items-baseline gap-4 py-3 border-b border-rule"
          >
            <Label>{e.at}</Label>
            <span className="text-[1.0625rem] text-ink flex-1">{e.detail}</span>
            <Label>{KIND_LABEL[e.kind]}</Label>
          </li>
        ))}
      </ul>

      <p className="mt-5 max-w-[46ch] text-[0.95rem] leading-snug text-ink-faint">
        Every row above is seeded. Rows from phones in this room appear at the
        top, unlabelled, because those are real.
      </p>
    </div>
  );
}
