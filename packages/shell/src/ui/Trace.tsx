"use client";

import { TRACE_BOX, emaSeries, tracePoints, traceTop } from "../core";

/**
 * The wallpaper's chart: a series and its exponential moving average, drawn as two lines across the lower right (see
 * `.os-trace` in desk.css), over a caption. The y axis runs from 0 to 1.1 × the largest value, so a flat series draws
 * a flat line. Fewer than two values draw nothing: the chart never shows data it doesn't have.
 */
export function Trace({ values, caption }: { values: readonly number[] | null; caption: string }) {
  if (!values || values.length < 2) return null;
  const top = traceTop(values);
  return (
    <figure className="os-trace">
      <svg viewBox={`0 0 ${TRACE_BOX.w} ${TRACE_BOX.h}`} preserveAspectRatio="none" className="os-trace-svg">
        <polyline points={tracePoints(values, top)} className="os-trace-observed" vectorEffect="non-scaling-stroke" />
        <polyline
          points={tracePoints(emaSeries(values), top)}
          className="os-trace-trend"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="os-trace-caption">{caption}</figcaption>
    </figure>
  );
}
