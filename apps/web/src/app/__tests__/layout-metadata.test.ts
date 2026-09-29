import { describe, expect, it, vi } from "vitest";
import { metadata } from "@/app/layout";

// A build replaces next/font/google with the font's files; run bare, it throws. The layout only needs the class names.
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));

describe("the page metadata", () => {
  const description = String(metadata.description);

  it("is titled 4rc.OS", () => {
    expect(metadata.title).toBe("4rc.OS");
  });

  // The README's intro and the About window's say what the apps do; a link preview and a search result say it from here.
  it("says what the desktop does, Revoke and the Terminal included", () => {
    for (const part of [/inspect/i, /mint/i, /send/i, /swap/i, /bridge/i, /revoke/i, /Terminal/]) {
      expect(description, String(part)).toMatch(part);
    }
  });

  it("is short enough that a search result shows all of it", () => {
    expect(description.length).toBeLessThanOrEqual(160);
  });
});
