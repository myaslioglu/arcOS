/**
 * The wallpaper chart's maths, kept pure so it can be tested: a series' exponential moving average, the top of its y
 * axis, and SVG polyline points in a fixed box that the SVG stretches to its size (preserveAspectRatio="none").
 */
export const TRACE_BOX = { w: 1200, h: 240 } as const;

/** The trend's smoothing: an EMA over about 64 values (α = 2 / (64 + 1)), about half a minute of Arc blocks. */
export const TRACE_EMA_ALPHA = 2 / 65;

export function emaSeries(values: readonly number[], alpha: number = TRACE_EMA_ALPHA): number[] {
  const out: number[] = [];
  let prev: number | undefined;
  for (const v of values) {
    prev = prev === undefined ? v : prev + alpha * (v - prev);
    out.push(prev);
  }
  return out;
}

/**
 * The top of the y axis: 1.1 × the largest value, or 1 when no value is above 0, so an idle chain draws a flat line at
 * the bottom rather than dividing by zero.
 */
export function traceTop(values: readonly number[]): number {
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  return max > 0 ? max * 1.1 : 1;
}

/**
 * Polyline points for `values`: x spread evenly across the box, y from 0 at the bottom to `top` at the top edge, one
 * decimal each. Values outside 0..top are kept inside the box. Fewer than two values draw nothing.
 */
export function tracePoints(values: readonly number[], top: number, box: { w: number; h: number } = TRACE_BOX): string {
  if (values.length < 2 || !(top > 0)) return "";
  const last = values.length - 1;
  return values
    .map((v, i) => {
      const y = box.h - (Math.min(Math.max(v, 0), top) / top) * box.h;
      return `${((i / last) * box.w).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
