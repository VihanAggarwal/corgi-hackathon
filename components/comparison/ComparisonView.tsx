import { AXES, type AxisKey } from "@/contracts/axes";
import type { ComparisonResult } from "@/contracts/types";
import { Label, Rule } from "@/components/ui/primitives";

function axisEnds(key: AxisKey) {
  const a = AXES.find((x) => x.key === key);
  return { low: a?.low ?? "", high: a?.high ?? "" };
}

/** -3..3 -> 0..100, clamped. A position on an axis, never a score. */
function pos(value: number): number {
  return Math.max(4, Math.min(96, ((value + 3) / 6) * 100));
}

/**
 * The divergence, drawn. Two positions on one named axis, with the axis ends
 * written out in words. No numbers about either person appear here: the whole
 * point of interpretable axes is that similarity can be said out loud instead
 * of scored.
 */
function DivergenceAxis({
  label,
  low,
  high,
  youAt,
  themAt,
  themName,
}: {
  label: string;
  low: string;
  high: string;
  youAt: number;
  themAt: number;
  themName: string;
}) {
  return (
    <div>
      <Label bright>{label}</Label>
      <div className="mt-6 relative h-16">
        <div className="absolute left-0 right-0 top-8 h-px bg-rule" />
        <Marker at={youAt} name="you" above />
        <Marker at={themAt} name={themName} />
      </div>
      <div className="flex justify-between">
        <Label>{low}</Label>
        <Label>{high}</Label>
      </div>
    </div>
  );
}

function Marker({
  at,
  name,
  above,
}: {
  at: number;
  name: string;
  above?: boolean;
}) {
  return (
    <div
      className="absolute flex flex-col items-center"
      style={{
        left: `${at}%`,
        transform: "translateX(-50%)",
        top: above ? 0 : "2.25rem",
      }}
    >
      {above ? (
        <>
          <span
            className="text-[1.0625rem] leading-none"
            style={{ color: "#ece7dd" }}
          >
            {name}
          </span>
          <span className="mt-2 block w-px h-4 bg-ink/70" />
        </>
      ) : (
        <>
          <span className="block w-px h-4" style={{ background: "#d2552e" }} />
          <span
            className="mt-2 text-[1.0625rem] leading-none"
            style={{ color: "#d2552e" }}
          >
            {name}
          </span>
        </>
      )}
    </div>
  );
}

export function ComparisonView({
  result,
  otherName,
  duelCount,
  twinLanguage,
  footer,
}: {
  result: ComparisonResult;
  otherName: string;
  duelCount: number;
  /**
   * False until the twin channel has cleared its floors. When false this screen
   * contains no reference to twins at all — not the verdict, not the headline —
   * and the generated verdict line is withheld rather than reworded, because
   * Track B does not rewrite generated copy.
   */
  twinLanguage: boolean;
  footer?: React.ReactNode;
}) {
  const ends = axisEnds(result.hardestDivergence.axis);
  const agreedOn = Math.round(result.agreementRate * duelCount);

  return (
    <div className="ink-in">
      {/* The headline is the honest outcome, and the interesting one is "no". */}
      <h1 className="display text-[2.75rem] sm:text-[4rem] max-w-[22ch]">
        {twinLanguage
          ? result.areTwins
            ? `You and ${otherName} are taste twins.`
            : `You and ${otherName} are not taste twins.`
          : result.areTwins
            ? `You and ${otherName} eat much the same way.`
            : `You and ${otherName} do not eat the same way.`}
      </h1>

      <p className="mt-5">
        <Label bright>
          agreed on {agreedOn} of {duelCount}
        </Label>
      </p>

      <div className="mt-10">
        <Rule />
        <div className="py-9">
          <DivergenceAxis
            label={`where you split: ${result.hardestDivergence.label}`}
            low={ends.low}
            high={ends.high}
            youAt={pos(result.hardestDivergence.aValue)}
            themAt={pos(result.hardestDivergence.bValue)}
            themName={otherName}
          />
        </div>
        <Rule />
      </div>

      {twinLanguage ? (
        <p className="prose-page mt-9 max-w-[46ch]">{result.verdictText}</p>
      ) : null}

      {footer ? <div className="mt-12">{footer}</div> : null}
    </div>
  );
}
