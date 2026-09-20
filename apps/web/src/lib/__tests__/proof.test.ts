import { describe, expect, it } from "vitest";
import type { Report } from "@arcos/inspector";
import { badgeSvg, summaryLine } from "../proof";

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
});
