import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Reads the two theme blocks of tokens.css the way the browser applies them: the dark block sits on
 * :root, so the light block inherits whatever it doesn't override, and var() resolves against the
 * theme it ends up in.
 */
function themes(): Record<"dark" | "light", Record<string, string>> {
  const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Record<string, Record<string, string>> = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const name = selector.includes('[data-theme="light"]') ? "light" : "dark";
    blocks[name] = Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  }
  const resolve = (vars: Record<string, string>) => {
    const out: Record<string, string> = {};
    const read = (key: string): string => {
      const value = vars[key];
      const ref = value?.match(/^var\(--([\w-]+)\)$/);
      return ref ? read(ref[1]) : value;
    };
    for (const key of Object.keys(vars)) out[key] = read(key);
    return out;
  };
  return { dark: resolve(blocks.dark), light: resolve({ ...blocks.dark, ...blocks.light }) };
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every token text is set in, and every surface text sits on. */
const TEXT = ["fg", "muted", "faint", "accent-text", "accent-2-text", "accent-3-text", "danger-text"];
const SURFACES = ["bg", "surface", "surface-2"];

describe("tokens.css", () => {
  const t = themes();

  for (const theme of ["dark", "light"] as const) {
    it(`sets every text token at WCAG AA (4.5:1) on every ${theme} surface`, () => {
      const failures: string[] = [];
      for (const fg of TEXT) {
        for (const bg of SURFACES) {
          const [a, b] = [t[theme][fg], t[theme][bg]];
          if (!/^#[0-9a-f]{6}$/i.test(a ?? "") || !/^#[0-9a-f]{6}$/i.test(b ?? "")) {
            failures.push(`--${fg} on --${bg}: ${a} / ${b} is not a colour`);
            continue;
          }
          const ratio = contrast(a, b);
          if (ratio < 4.5) failures.push(`--${fg} ${a} on --${bg} ${b}: ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("uses the badge's red for danger in the light theme", () => {
    expect(t.light.danger.toLowerCase()).toBe("#b42318");
    expect(t.light["danger-text"].toLowerCase()).toBe("#b42318");
  });
});
