"use client";

import type { DishView } from "@/components/data";
import { Label } from "@/components/ui/primitives";

/**
 * Muted plate tones, chosen deterministically per dish. These are the only
 * colors in the product other than food photography, and they exist so a tile
 * with no photo still reads as a specific dish rather than an empty box.
 */
const TONES = [
  "#341f1a", // clay
  "#232b1c", // olive
  "#2b1e2c", // plum
  "#33290f", // ochre
  "#152628", // deep teal
  "#2f1a16", // brick
];

function tone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return TONES[h % TONES.length];
}

export function DishCard({
  dish,
  onPick,
  picked,
  dimmed,
  eager,
}: {
  dish: DishView;
  onPick?: (dishId: string) => void;
  picked?: boolean;
  dimmed?: boolean;
  /** true for the first pair: no entrance animation, nothing to wait for */
  eager?: boolean;
}) {
  const interactive = Boolean(onPick);

  return (
    <button
      type="button"
      onClick={() => onPick?.(dish.dishId)}
      disabled={!interactive}
      aria-label={`${dish.name}, ${dish.venueName}`}
      className={[
        "group relative w-full h-full min-h-0 overflow-hidden text-left",
        "border border-rule transition-[opacity,border-color] duration-150",
        interactive ? "cursor-pointer active:border-rule-bright" : "cursor-default",
        picked ? "picked border-rule-bright" : "",
        dimmed ? "opacity-30" : "opacity-100",
        eager ? "" : "rise",
      ].join(" ")}
      style={{ background: tone(dish.dishId) }}
    >
      {dish.imageUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={dish.imageUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            loading={eager ? "eager" : "lazy"}
            decoding="async"
          />
          <div className="absolute inset-0 bg-[#0a0a0b]/45" />
        </>
      ) : null}

      <div className="relative h-full flex flex-col justify-between p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <Label bright>{dish.venueName}</Label>
          <Label>{dish.neighborhood}</Label>
        </div>

        <div>
          <h2 className="display text-[2rem] sm:text-[2.75rem] leading-[0.95] text-ink">
            {dish.name}
          </h2>
          {dish.description ? (
            <p className="mt-3 max-w-[26rem] text-[0.95rem] leading-snug text-ink-dim">
              {dish.description}
            </p>
          ) : null}
        </div>

        <div className="flex items-end justify-between">
          <Label>
            {dish.priceCents != null
              ? `$${(dish.priceCents / 100).toFixed(0)}`
              : ""}
          </Label>
          {interactive ? (
            <Label className="opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              this one
            </Label>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export { tone as dishTone };
