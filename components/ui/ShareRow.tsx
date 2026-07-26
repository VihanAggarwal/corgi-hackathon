"use client";

import { useState } from "react";
import { Label, Rule } from "@/components/ui/primitives";

/**
 * The only outbound action in the product: hand a link to someone you already
 * talk to. There is no follow, no DM, no reply path, and nothing here reaches a
 * stranger. Sharing goes through the OS sheet, which means it lands in the
 * thread the two of you were already in.
 */
export function ShareRow({
  path,
  label,
  text,
}: {
  path: string;
  label: string;
  text: string;
}) {
  const [state, setState] = useState<"idle" | "copied">("idle");

  async function share() {
    const url =
      typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
    try {
      if (navigator.share) {
        await navigator.share({ url, text });
        return;
      }
    } catch {
      // sheet dismissed; fall through to the clipboard
    }
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
      window.setTimeout(() => setState("idle"), 2400);
    } catch {
      setState("idle");
    }
  }

  return (
    <>
      <Rule />
      <button
        type="button"
        onClick={share}
        className="w-full flex items-baseline justify-between py-6 border-b border-rule hover:border-rule-bright transition-colors text-left"
      >
        <span className="display text-[1.75rem] sm:text-[2.25rem]">{label}</span>
        <Label bright>{state === "copied" ? "link copied" : "send"}</Label>
      </button>
    </>
  );
}
