import { afterEach, describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";

// A build replaces next/font/google with the font's files; run bare, it throws. The layout only needs the class names.
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));

/** The layout's metadata as a build for `network` has it: Next inlines NEXT_PUBLIC_ARC_NETWORK where the module is built. */
async function metadataFor(network: "mainnet" | "testnet"): Promise<Metadata> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", network);
  return (await import("@/app/layout")).metadata;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the page metadata", () => {
  let metadata: Metadata;
  let description = "";

  it("is titled 4rc.OS on mainnet", async () => {
    metadata = await metadataFor("mainnet");
    description = String(metadata.description);
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

describe("the page metadata per network", () => {
  it("leaves robots unset on mainnet, as before: indexable", async () => {
    const metadata = await metadataFor("mainnet");
    expect(metadata).not.toHaveProperty("robots");
  });

  it("asks search engines to leave the testnet site out, and titles it as the testnet", async () => {
    const metadata = await metadataFor("testnet");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("4rc.OS Testnet");
    expect(String(metadata.description)).toBe(String((await metadataFor("mainnet")).description));
  });
});
