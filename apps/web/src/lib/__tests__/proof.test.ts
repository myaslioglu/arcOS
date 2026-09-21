import { describe, expect, it } from "vitest";
import type { Finding, Report } from "@arcos/inspector";
import { NAME_DISCLOSURE, badgeColor, badgeSvg, passLine, rankFindings, readAtLine, shortLabel, summaryLine } from "../proof";

const report = (over: Partial<Report> = {}): Report => ({
  address: "0x1111111111111111111111111111111111111111",
  network: "mainnet",
  token: { name: "Duke", symbol: "DUKE", decimals: 18, totalSupply: "1" },
  findings: [],
  passed: 3,
  total: 8,
  counts: { pass: 3, warn: 3, fail: 2, unknown: 0 },
  explorerReachable: true,
  blockNumber: "1",
  generatedAt: "2026-09-20T00:00:00.000Z",
  ...over,
});

describe("passLine", () => {
  it("shows just the pass count when nothing is unknown", () => {
    expect(passLine(report())).toBe("3 of 8 checks pass");
  });
  it("adds an explicit unknown clause when some checks couldn't be checked", () => {
    expect(passLine(report({ counts: { pass: 5, warn: 0, fail: 0, unknown: 3 } }))).toBe("5 of 8 checks pass · 3 couldn't be checked");
  });
});

describe("summaryLine", () => {
  it("names the token and the count", () => {
    expect(summaryLine(report())).toBe("DUKE on Arc — 3 of 8 checks pass");
  });
  it("carries the unknown clause too", () => {
    expect(summaryLine(report({ counts: { pass: 5, warn: 0, fail: 0, unknown: 3 } }))).toBe("DUKE on Arc — 5 of 8 checks pass · 3 couldn't be checked");
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
    expect(readAtLine(report({ blockNumber: "123", generatedAt: "2026-09-20T00:00:00Z" }))).toBe(
      "Read at block 123 · 2026-09-20 00:00 UTC",
    );
  });
  it("falls back to an unknown block", () => {
    expect(readAtLine(report({ blockNumber: "unknown", generatedAt: "2026-09-20T00:00:00Z" }))).toBe(
      "Read at an unknown block · 2026-09-20 00:00 UTC",
    );
  });
});

describe("badgeColor", () => {
  it("is grey when there is no report", () => {
    expect(badgeColor(null)).toBe("#6b6f79");
  });
  it("is red when any check fails, regardless of unknowns", () => {
    expect(badgeColor({ pass: 5, warn: 0, fail: 1, unknown: 2 })).toBe("#b42318");
  });
  it("is amber when there's a warn but no fail", () => {
    expect(badgeColor({ pass: 5, warn: 1, fail: 0, unknown: 2 })).toBe("#b97309");
  });
  it("is grey — not red or amber — when unknowns pile up with nothing worse found", () => {
    expect(badgeColor({ pass: 5, warn: 0, fail: 0, unknown: 3 })).toBe("#6b6f79");
  });
  // A green badge reads as "all checks passed" to anyone who never reads the text — so it must not
  // render green while even one check is still unresolved, no matter how few (was: only >= 3).
  it("is grey — not green — when even a single check is unknown and nothing worse was found", () => {
    expect(badgeColor({ pass: 7, warn: 0, fail: 0, unknown: 1 })).toBe("#6b6f79");
  });
  it("is grey when unknowns are few (was the exact threshold that used to slip through green)", () => {
    expect(badgeColor({ pass: 6, warn: 0, fail: 0, unknown: 2 })).toBe("#6b6f79");
  });
  it("is green only when there are zero fails, zero warns and zero unknowns", () => {
    expect(badgeColor({ pass: 8, warn: 0, fail: 0, unknown: 0 })).toBe("#0c8a4e");
  });
});

describe("badgeSvg", () => {
  it("shows the pass count", () => {
    expect(badgeSvg(report())).toContain("3/8 pass");
  });
  it("shows an unknown marker when some checks are unknown", () => {
    const svg = badgeSvg(report({ counts: { pass: 5, warn: 0, fail: 0, unknown: 3 } }));
    expect(svg).toContain("5/8 pass · 3 ?");
  });
  it("escapes a hostile symbol", () => {
    const svg = badgeSvg(report({ token: { name: null, symbol: `<script>"&`, decimals: null, totalSupply: null } }));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&quot;&amp;");
  });
  it("renders a neutral badge when there is no report", () => {
    expect(badgeSvg(null)).toContain("not inspected");
  });
  it("pins the width for a known case (DUKE, 3/8 pass)", () => {
    expect(badgeSvg(report())).toContain('width="108"');
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
    const expected = `DUKE: 3/8 pass — automated analysis, not investment advice — ${NAME_DISCLOSURE}`;
    expect(svg).toContain(`<svg xmlns="http://www.w3.org/2000/svg" width="108" height="22" role="img" aria-label="${expected}"><title>${expected}</title>`);
  });
  it("neutral badge title has no disclaimer clause, and no name disclosure (there's no name to disclose)", () => {
    const svg = badgeSvg(null);
    expect(svg).toContain("<title>ARC.os: not inspected</title>");
    expect(svg).not.toContain("investment advice");
    expect(svg).not.toContain(NAME_DISCLOSURE);
  });
  it("carries the name-is-creator-chosen disclosure in the title too, same wording as the proof page", () => {
    const svg = badgeSvg(report());
    expect(svg).toContain(NAME_DISCLOSURE);
  });
  it("appends the explorer-didn't-answer fact to the title when the explorer wasn't reachable", () => {
    const svg = badgeSvg(report({ explorerReachable: false }));
    expect(svg).toContain("the explorer didn't answer some checks");
  });
  it("says nothing about the explorer when it was reachable", () => {
    expect(badgeSvg(report({ explorerReachable: true }))).not.toContain("explorer");
  });

  it("colours unknowns differently from fails — same pass count, different badge", () => {
    const unknownHeavy = badgeSvg(report({ counts: { pass: 5, warn: 0, fail: 0, unknown: 3 } }));
    const failHeavy = badgeSvg(report({ counts: { pass: 5, warn: 0, fail: 3, unknown: 0 } }));
    expect(unknownHeavy).not.toBe(failHeavy);
    expect(unknownHeavy).toContain("#6b6f79"); // grey: unknowns, nothing worse
    expect(failHeavy).toContain("#b42318"); // red: a real fail
  });
});

describe("rankFindings", () => {
  const f = (id: string, status: Finding["status"]): Finding => ({ id: id as Finding["id"], status, title: id, detail: "", evidenceUrl: null, fixAppId: null });

  it("ranks fail > warn > unknown > pass", () => {
    const findings = [f("a", "pass"), f("b", "unknown"), f("c", "warn"), f("d", "fail")];
    const { shown } = rankFindings(findings, 4);
    expect(shown.map((x) => x.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("is stable within a rank", () => {
    const findings = [f("first-pass", "pass"), f("first-fail", "fail"), f("second-fail", "fail"), f("second-pass", "pass")];
    const { shown } = rankFindings(findings, 4);
    expect(shown.map((x) => x.id)).toEqual(["first-fail", "second-fail", "first-pass", "second-pass"]);
  });

  it("shows up to the limit and reports how many were cut", () => {
    const findings = Array.from({ length: 8 }, (_, i) => f(`f${i}`, "pass"));
    const { shown, hiddenCount } = rankFindings(findings, 4);
    expect(shown).toHaveLength(4);
    expect(hiddenCount).toBe(4);
  });

  it("reports zero hidden when everything fits", () => {
    const { hiddenCount } = rankFindings([f("a", "pass")], 4);
    expect(hiddenCount).toBe(0);
  });
});
