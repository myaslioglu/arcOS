import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MOTION = "@media (prefers-reduced-motion: no-preference)";
const STILL = "@media (prefers-reduced-motion: reduce)";
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = stripComments(readFileSync(new URL("../desk.css", import.meta.url), "utf8"));
const desktopCss = stripComments(readFileSync(new URL("../desktop.css", import.meta.url), "utf8"));
const desktopPage = readFileSync(new URL("../../../../../apps/web/src/app/page.tsx", import.meta.url), "utf8");

/** Where the block that begins at `from` ends: the index of its closing brace, found by matching braces. */
function blockEnd(text: string, from: number): number {
  let depth = 0;
  let end = text.indexOf("{", from);
  for (; end < text.length; end++) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}" && --depth === 0) break;
  }
  return end;
}

/** The stylesheet with every block that opens with `header` cut out. */
function withoutBlocks(text: string, header: string): string {
  let out = text;
  for (let at = out.indexOf(header); at !== -1; at = out.indexOf(header)) {
    out = out.slice(0, at) + out.slice(blockEnd(out, at) + 1);
  }
  return out;
}

/** What sits inside each block that opens with `header`. */
function blocksInside(text: string, header: string): string[] {
  const found: string[] = [];
  for (let at = text.indexOf(header); at !== -1; at = text.indexOf(header, at + header.length)) {
    found.push(text.slice(text.indexOf("{", at) + 1, blockEnd(text, at)));
  }
  return found;
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
    // A reduce block may only switch motion off; the test below checks what it holds.
    expect(withoutBlocks(withoutBlocks(css, MOTION), STILL)).not.toMatch(
      /(?:^|[\s;{])(?:transition|animation)(?:-[a-z-]+)?\s*:/,
    );
  });

  it("stills the app icons under reduced motion: no transition, no hover lift, and no property that could move a box", () => {
    const [still, ...more] = blocksInside(css, STILL);
    expect(still, "a reduced-motion block").toBeDefined();
    expect(more).toEqual([]);
    const rules = [...(still ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
      selectors: selector.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
      declarations: body
        .split(";")
        .map((d) => d.trim().replace(/\s+/g, " "))
        .filter(Boolean),
    }));
    const stilled = (selector: string, declaration: string) =>
      rules.some((r) => r.selectors.includes(selector) && r.declarations.includes(declaration));
    expect(stilled(".os-icon", "transition: none")).toBe(true);
    expect(stilled(".os-icon-tile", "transition: none")).toBe(true);
    // `.os-icon-tile` alone (0,1,0) would lose to the rule that lifts the tile (0,3,0), so the lift is reset by that
    // rule's own selector, which desktop.css must still spell the same way.
    expect(desktopCss).toMatch(/\.os-icon:hover \.os-icon-tile\s*\{[^}]*transform:\s*translateY/);
    expect(stilled(".os-icon:hover .os-icon-tile", "transform: none")).toBe(true);
    // Motion off and nothing else: a layout property here would change the desk under a reduced-motion setting only.
    expect(rules.flatMap((r) => r.declarations).filter((d) => !/^(?:transition|transform): none$/.test(d))).toEqual([]);
  });

  // The reduce block above beats desktop.css's own transition and hover lift only by coming after it, at equal specificity,
  // so the desktop page has to import desktop.css first.
  it("is imported by the desktop page after desktop.css, which is what lets its reduce block win", () => {
    const sheets = [...desktopPage.matchAll(/^import\s+["']([^"']+\.css)["'];?\s*$/gm)].map((m) => m[1]);
    const desktop = sheets.indexOf("@arcos/shell/styles/desktop.css");
    const desk = sheets.indexOf("@arcos/shell/styles/desk.css");
    expect(desktop, "desktop.css imported by the page").toBeGreaterThan(-1);
    expect(desk, "desk.css imported by the page").toBeGreaterThan(-1);
    expect(desktop).toBeLessThan(desk);
  });

  // A 1366x768 laptop leaves about 657px inside the browser. The desk kept a 7rem cushion above 640px, which scrolled it
  // by up to 21px there; 5rem clears the dock and fits a 640px screen, so it holds at every height.
  it("keeps one bottom cushion at every screen height, so a laptop's desk doesn't scroll", () => {
    const desk = css.match(/\.os-desk\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(desk).toMatch(/padding:\s*18px 14px 5rem;/);
    expect(css).not.toMatch(/@media[^{]*\b(?:max|min)-height/);
  });
});
