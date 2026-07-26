import Link from "next/link";
import type { ReactNode } from "react";

/** Machine label. Axis names, sources, counts, states. Never a person's score. */
export function Label({
  children,
  bright,
  className = "",
}: {
  children: ReactNode;
  bright?: boolean;
  className?: string;
}) {
  return (
    <span className={`label ${bright ? "label-bright" : ""} ${className}`}>
      {children}
    </span>
  );
}

/** Hairline. The only divider in the product. */
export function Rule({ className = "" }: { className?: string }) {
  return <hr className={`border-0 border-t border-rule ${className}`} />;
}

/** A page. Mobile-first column, generous margins, nothing centered-cute. */
export function Screen({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main
      className={`flex-1 w-full max-w-[54rem] mx-auto px-6 sm:px-10 ${className}`}
    >
      {children}
    </main>
  );
}

/** Masthead. Same on every screen, small, no navigation chrome. */
export function Masthead({ right }: { right?: ReactNode }) {
  return (
    <header className="w-full max-w-[54rem] mx-auto px-6 sm:px-10 pt-6 pb-5 flex items-baseline justify-between">
      <Link href="/" className="label label-bright tracking-[0.22em]">
        Taste&nbsp;Twins
      </Link>
      {right}
    </header>
  );
}

/**
 * Anything on screen that came from a seed rather than from a real person
 * carries this. We do not present fabricated history as usage.
 */
export function SeededBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`label border border-rule px-2 py-1 text-ember/90 ${className}`}
      style={{ color: "#d2552e" }}
    >
      seeded demo data
    </span>
  );
}

export function Price({ cents }: { cents: number | null }) {
  if (cents == null) return null;
  return <Label>${(cents / 100).toFixed(0)}</Label>;
}
