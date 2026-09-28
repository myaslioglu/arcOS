import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MOTION = "@media (prefers-reduced-motion: no-preference)";
const css = readFileSync(new URL("../desk.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The stylesheet with every no-preference motion block cut out, found by matching braces. */
function outsideMotionBlocks(text: string): string {
  let out = text;
  for (let at = out.indexOf(MOTION); at !== -1; at = out.indexOf(MOTION)) {
    let depth = 0;
    let end = out.indexOf("{", at);
    for (; end < out.length; end++) {
      if (out[end] === "{") depth++;
      else if (out[end] === "}" && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
  return out;
}

describe("desk.css", () => {
  it("sets every colour from a token", () => {
    const literals =
      css.match(
        /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink)(?![\w-])/g,
      ) ?? [];
    expect(literals).toEqual([]);
  });

  it("moves only inside a no-preference motion block, so a reduced-motion setting stills it", () => {
    expect(css).toContain(MOTION);
    expect(outsideMotionBlocks(css)).not.toMatch(/(?:^|[\s;{])(?:transition|animation)(?:-[a-z-]+)?\s*:/);
  });
});
