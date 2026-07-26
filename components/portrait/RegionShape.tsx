import { AXIS_KEYS } from "@/contracts/axes";
import type { PalateRegion } from "@/contracts/types";
import { Label } from "@/components/ui/primitives";

/**
 * The only chart in the product.
 *
 * One shape, two states: the region of flavor space this person has eaten in
 * two weeks ago, and now. It is deliberately not a radar chart — no axis
 * spokes, no labels, no gridlines, no numbers — because the moment it acquires
 * an axis legend it becomes a dashboard about a person, which is the thing this
 * product does not do. What it shows is one honest fact: the shape got bigger,
 * and it got bigger in particular directions.
 */

const SIZE = 320;
const CENTER = SIZE / 2;
const BASE = 62;
const REACH = 74;

function radii(region: PalateRegion): number[] {
  const explored = new Set(region.exploredAxes);
  return AXIS_KEYS.map((key, i) => {
    // Deterministic wobble so the shape reads as organic rather than plotted.
    const wobble = ((i * 37) % 11) / 11;
    const reach = explored.has(key) ? REACH * (0.72 + wobble * 0.28) : 0;
    return BASE * (0.82 + wobble * 0.18) + reach;
  });
}

/** Closed shape through the points, smoothed by quadratic midpoints. */
function pathFrom(rs: number[]): string {
  const pts = rs.map((r, i) => {
    const a = (i / rs.length) * Math.PI * 2 - Math.PI / 2;
    return [CENTER + Math.cos(a) * r, CENTER + Math.sin(a) * r] as const;
  });

  const mid = (i: number) => {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as const;
  };

  let d = `M ${mid(pts.length - 1)[0].toFixed(2)} ${mid(pts.length - 1)[1].toFixed(2)}`;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const m = mid(i);
    d += ` Q ${c[0].toFixed(2)} ${c[1].toFixed(2)} ${m[0].toFixed(2)} ${m[1].toFixed(2)}`;
  }
  return `${d} Z`;
}

export function RegionShape({
  before,
  after,
  caption,
}: {
  before: PalateRegion;
  after: PalateRegion;
  caption: string;
}) {
  const beforePath = pathFrom(radii(before));
  const afterPath = pathFrom(radii(after));

  return (
    <figure className="my-4">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width="100%"
        height="auto"
        className="max-w-[20rem]"
        role="img"
        aria-label={caption}
      >
        {/* now: filled, faint */}
        <path d={afterPath} fill="#ece7dd" fillOpacity={0.09} stroke="#ece7dd" strokeOpacity={0.55} strokeWidth={1} />
        {/* two weeks ago: hairline only */}
        <path d={beforePath} fill="none" stroke="#d2552e" strokeOpacity={0.85} strokeWidth={1} strokeDasharray="3 4" />
      </svg>
      <figcaption className="mt-4 flex flex-col gap-2">
        <Label bright>{caption}</Label>
        <span className="flex gap-5">
          <Label>
            <span style={{ color: "#d2552e" }}>——</span> two weeks ago
          </Label>
          <Label>
            <span style={{ color: "#ece7dd" }}>——</span> now
          </Label>
        </span>
      </figcaption>
    </figure>
  );
}
