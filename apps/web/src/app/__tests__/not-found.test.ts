import { describe, expect, it } from "vitest";
import NotFound from "@/app/not-found";

type Node = { type: unknown; props: { children?: unknown; className?: string; style?: unknown; href?: string } };
const isNode = (n: unknown): n is Node => typeof n === "object" && n !== null && "props" in n;

function* nodes(n: unknown): Generator<Node> {
  if (Array.isArray(n)) for (const child of n) yield* nodes(child);
  else if (isNode(n)) {
    yield n;
    yield* nodes(n.props.children);
  }
}
const text = (n: unknown): string =>
  typeof n === "string" ? n : Array.isArray(n) ? n.map(text).join("") : isNode(n) ? text(n.props.children) : "";

// Any colour the theme can't change: a Tailwind palette colour, an arbitrary value, or a fixed keyword.
const FIXED_COLOUR =
  /(^|\s)(text|bg|border|ring|outline|fill|stroke|decoration|shadow)-(\[|black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)/;

// Next's built-in 404 ships its own `body{color:#000;background:#fff}` with a prefers-color-scheme
// override, so it follows the OS instead of the visitor's choice. This one replaces it.
describe("the not-found page", () => {
  const page = NotFound();
  const all = [...nodes(page)];

  it("says what happened and links back to the desktop", () => {
    expect(text(all.find((n) => n.type === "h1"))).toBe("Page not found");
    const link = all.find((n) => n.props.href !== undefined);
    expect(link?.props.href).toBe("/");
    expect(text(link)).toBe("Open 4rc.OS");
  });

  it("is built from the theme's token classes, so it follows the stored theme", () => {
    expect(all.some((n) => n.type === "style")).toBe(false);
    for (const n of all) {
      expect(n.props.style, String(n.type)).toBeUndefined();
      expect(n.props.className ?? "", String(n.type)).not.toMatch(FIXED_COLOUR);
    }
    expect(all.map((n) => n.props.className ?? "").join(" ")).toMatch(/(^|\s)text-muted(\s|$)/);
  });
});
