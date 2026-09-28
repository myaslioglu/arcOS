import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emaSeries, tracePoints, traceTop } from "../../core";
import { Trace } from "../Trace";
import { Wallpaper } from "../Wallpaper";

describe("Trace", () => {
  it("draws nothing until it has two values", () => {
    expect(renderToStaticMarkup(createElement(Trace, { values: null, caption: "x" }))).toBe("");
    expect(renderToStaticMarkup(createElement(Trace, { values: [0.1], caption: "x" }))).toBe("");
  });

  it("draws the observed line under its trend, over the caption", () => {
    const values = [0, 0.5, 1];
    const top = traceTop(values);
    const html = renderToStaticMarkup(
      createElement(Trace, { values, caption: "arc · observed / trend · last 3 blocks" }),
    );
    expect(html).toMatch(/^<figure class="os-trace"><svg viewBox="0 0 1200 240" preserveAspectRatio="none" class="os-trace-svg">/);
    expect(html).toContain(`points="${tracePoints(values, top)}" class="os-trace-observed"`);
    expect(html).toContain(`points="${tracePoints(emaSeries(values), top)}" class="os-trace-trend"`);
    expect(html.indexOf("os-trace-observed")).toBeLessThan(html.indexOf("os-trace-trend"));
    expect(html).toContain('<figcaption class="os-trace-caption">arc · observed / trend · last 3 blocks</figcaption>');
  });
});

describe("Wallpaper", () => {
  it("lays the grid, the glow and the noise under whatever it holds, hidden from assistive technology", () => {
    const html = renderToStaticMarkup(createElement(Wallpaper, null, createElement("i", { id: "slot" })));
    expect(html).toBe(
      '<div class="os-wallpaper" aria-hidden="true"><div class="os-wallpaper-grid"></div><div class="os-wallpaper-glow"></div><div class="os-wallpaper-noise"></div><i id="slot"></i></div>',
    );
  });
});
