import { describe, expect, it } from "vitest";
import type { Report } from "@arcos/inspector";
import { badgeSvg, readAtLine, shortLabel, summaryLine } from "../proof";

const report = (over: Partial<Report> = {}): Report => ({
  address: "0x1111111111111111111111111111111111111111",
  network: "mainnet",
  token: { name: "Duke", symbol: "DUKE", decimals: 18, totalSupply: "1" },
  findings: [],
  passed: 3,
  total: 8,
  explorerReachable: true,
  blockNumber: "1",
  generatedAt: "2026-09-20T00:00:00.000Z",
  ...over,
});

describe("summaryLine", () => {
  it("names the token and the count", () => {
    expect(summaryLine(report())).toBe("DUKE on Arc — 3 of 8 checks pass");
  });
  it("falls back to a short address", () => {
    expect(summaryLine(report({ token: { name: null, symbol: null, decimals: null, totalSupply: null } }))).toBe(
      "0x1111…1111 on Arc — 3 of 8 checks pass",
    );
  });
});

describe("shortLabel", () => {
  it("slices plain text to the code point limit", () => {
    expect(shortLabel("hello world", 5)).toBe("hello");
  });
  it("returns text shorter than the limit unchanged", () => {
    expect(shortLabel("hi", 5)).toBe("hi");
  });
  it("keeps a surrogate-pair emoji intact instead of splitting it", () => {
    const text = "😀".repeat(20);
    const result = shortLabel(text, 16);
    expect(Array.from(result)).toHaveLength(16);
    expect(result).toBe("😀".repeat(16));
  });
});

describe("readAtLine", () => {
  it("names the block number", () => {
    expect(readAtLine(report({ blockNumber: "123", generatedAt: "2026-09-20T00:00:00.000Z" }))).toBe(
      "Read at block 123 · 2026-09-20 00:00 UTC",
    );
  });
  it("falls back to an unknown block", () => {
    expect(readAtLine(report({ blockNumber: "unknown", generatedAt: "2026-09-20T00:00:00.000Z" }))).toBe(
      "Read at an unknown block · 2026-09-20 00:00 UTC",
    );
  });
});

describe("badgeSvg", () => {
  it("shows the count", () => {
    expect(badgeSvg(report())).toContain("3/8 checks");
  });
  it("escapes a hostile symbol", () => {
    const svg = badgeSvg(report({ token: { name: null, symbol: `<script>"&`, decimals: null, totalSupply: null } }));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&quot;&amp;");
  });
  it("renders a neutral badge when there is no report", () => {
    expect(badgeSvg(null)).toContain("not inspected");
  });
  it("pins the width for a known case (DUKE, 3/8 checks)", () => {
    expect(badgeSvg(report())).toContain('width="122"');
  });
  it("computes width from the visible label, not the escaped one", () => {
    const widthOf = (svg: string) => svg.match(/^<svg[^>]*\bwidth="(\d+)"/)?.[1];
    const hostile = badgeSvg(report({ token: { name: null, symbol: "<".repeat(16), decimals: null, totalSupply: null } }));
    const plain = badgeSvg(report({ token: { name: null, symbol: "A".repeat(16), decimals: null, totalSupply: null } }));
    expect(widthOf(hostile)).toBe(widthOf(plain));
    expect(widthOf(hostile)).toBeDefined();
  });
  it("carries the disclaimer in a <title> as the first child, and in aria-label", () => {
    const svg = badgeSvg(report());
    const expected = "DUKE: 3/8 checks — automated analysis, not investment advice";
    expect(svg).toContain(`<svg xmlns="http://www.w3.org/2000/svg" width="122" height="22" role="img" aria-label="${expected}"><title>${expected}</title>`);
  });
  it("neutral badge title has no disclaimer clause", () => {
    const svg = badgeSvg(null);
    expect(svg).toContain("<title>ARC.os: not inspected</title>");
    expect(svg).not.toContain("investment advice");
  });
});
