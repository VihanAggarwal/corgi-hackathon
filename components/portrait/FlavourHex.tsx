/**
 * The flavour hexagon.
 *
 * WHY SIX AXES AND NOT TWENTY FOUR
 * A twenty four spoke radar is unreadable and, worse, dishonest: most of those
 * axes are masked or near zero for any real person, so drawing them all implies
 * a precision the model does not have. Six grouped families are what a human
 * can actually read at a glance, and each one is an average of the axes that
 * belong to it.
 *
 * THE ONE CHART IN THE PRODUCT
 * docs/BUILD-SPEC allows exactly one visual on the portrait screen and nothing
 * anywhere else. This is it. It carries NO numbers: hard rule 1 forbids a score
 * about a person, and a radar chart with a printed scale is a score with extra
 * steps. Shape and axis names only.
 */

import { AXIS_KEYS, type AxisKey } from "@/contracts/axes";
import type { Vec24 } from "@/contracts/types";

/** The six families, and the axes averaged into each. */
const FAMILIES: Array<{ label: string; axes: AxisKey[] }> = [
  { label: "heat", axes: ["heat_capsaicin", "heat_numbing", "aromatic_spice"] },
  { label: "acid", axes: ["acid", "herb_freshness"] },
  { label: "richness", axes: ["fat_richness", "texture_creamy", "protein_prominence"] },
  { label: "funk", axes: ["funk_ferment", "umami_depth", "bitterness"] },
  { label: "char", axes: ["char_smoke", "salt", "garlic_allium"] },
  { label: "texture", axes: ["texture_crunch", "texture_chew", "effort_to_eat"] },
];

function familyValue(theta: Vec24, axes: AxisKey[]): number {
  let sum = 0;
  let n = 0;
  for (const a of axes) {
    const i = AXIS_KEYS.indexOf(a);
    if (i >= 0) {
      sum += theta[i];
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** theta runs roughly -3..3. Map to a 0..1 radius, clamped. */
function radius(value: number): number {
  return Math.max(0.12, Math.min(1, (value + 3) / 6));
}

const SIZE = 260;
const CENTER = SIZE / 2;
const MAX_R = 92;

function point(index: number, r: number): [number, number] {
  // Start at twelve o'clock so the shape reads upright rather than rotated.
  const angle = (Math.PI * 2 * index) / FAMILIES.length - Math.PI / 2;
  return [CENTER + Math.cos(angle) * r, CENTER + Math.sin(angle) * r];
}

function polygon(radii: number[]): string {
  return radii.map((r, i) => point(i, r).join(",")).join(" ");
}

export function FlavourHex({
  theta,
  /** An earlier vector, drawn faintly behind, so growth is visible as shape. */
  previous,
  className = "",
}: {
  theta: Vec24;
  previous?: Vec24;
  className?: string;
}) {
  const now = FAMILIES.map((f) => radius(familyValue(theta, f.axes)) * MAX_R);
  const before = previous
    ? FAMILIES.map((f) => radius(familyValue(previous, f.axes)) * MAX_R)
    : null;

  return (
    <figure className={className}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full max-w-[19rem] mx-auto overflow-visible"
        role="img"
        aria-label={`Flavour profile across ${FAMILIES.map((f) => f.label).join(", ")}`}
      >
        {/* Rings. Unlabeled on purpose: a labeled scale is a score. */}
        {[0.33, 0.66, 1].map((step) => (
          <polygon
            key={step}
            points={polygon(FAMILIES.map(() => MAX_R * step))}
            fill="none"
            stroke="#2a2925"
            strokeWidth={1}
          />
        ))}

        {FAMILIES.map((_, i) => {
          const [x, y] = point(i, MAX_R);
          return (
            <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke="#2a2925" strokeWidth={1} />
          );
        })}

        {before ? (
          <polygon
            points={polygon(before)}
            fill="none"
            stroke="#6c6862"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ) : null}

        <polygon
          points={polygon(now)}
          fill="#d2552e"
          fillOpacity={0.16}
          stroke="#d2552e"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {now.map((r, i) => {
          const [x, y] = point(i, r);
          return <circle key={i} cx={x} cy={y} r={2.5} fill="#d2552e" />;
        })}

        {FAMILIES.map((f, i) => {
          const [x, y] = point(i, MAX_R + 24);
          return (
            <text
              key={f.label}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="label"
              fill="#a29c92"
              fontSize={11}
              letterSpacing={2}
            >
              {f.label}
            </text>
          );
        })}
      </svg>

      {before ? (
        <figcaption className="label text-ink-faint text-center mt-3">
          dashed is where you started
        </figcaption>
      ) : null}
    </figure>
  );
}
