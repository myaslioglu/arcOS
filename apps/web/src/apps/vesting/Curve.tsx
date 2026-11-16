import { curvePoints } from "./schedule";
import { nowFraction } from "./view";

const W = 240;
const H = 72;
const PAD = 4;

/**
 * The release curve of a schedule, drawn from `schedulePreview`: the share released from the start to the end, flat
 * until the cliff, with a mark for "now" when it's inside the schedule. The shape doesn't depend on the amount, so
 * it is drawn for a fixed one. A small inline SVG: no chart library.
 */
export function Curve({ start, duration, cliff, now, label }: { start: bigint; duration: bigint; cliff: bigint; now?: bigint; label: string }) {
  const points = curvePoints(10_000n, start, duration, cliff);
  if (points.length === 0) return null;
  const x = (f: number) => PAD + f * (W - 2 * PAD);
  const y = (f: number) => H - PAD - f * (H - 2 * PAD);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.x).toFixed(1)} ${y(p.y).toFixed(1)}`).join(" ");
  const at = now === undefined ? null : nowFraction(start, duration, now);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full text-accent-text">
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-border-2" strokeWidth={1} />
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="stroke-border-2" strokeWidth={1} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {at !== null && (
        <g data-testid="now-mark">
          <line x1={x(at)} y1={PAD} x2={x(at)} y2={H - PAD} className="stroke-accent-3-text" strokeWidth={1.5} strokeDasharray="3 3" />
        </g>
      )}
    </svg>
  );
}
