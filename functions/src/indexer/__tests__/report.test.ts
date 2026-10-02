import { describe, expect, it } from "vitest";
import type { Finding, Pool, PoolScan, Report } from "@arcos/inspector";
import { bestPoolOf, summarize } from "../report";
import { at } from "./helpers";

const finding = (id: Finding["id"], status: Finding["status"]): Finding => ({ id, status, title: "", detail: "", evidenceUrl: null, fixAppId: null });

function report(statuses: Finding["status"][], over: Partial<Report> = {}): Report {
  const ids: Finding["id"][] = ["verified", "ownership", "privileges", "proxy", "holders", "liquidity", "lp-lock", "prevrandao"];
  const findings = statuses.map((status, i) => finding(ids[i]!, status));
  const count = (s: Finding["status"]) => findings.filter((f) => f.status === s).length;
  return {
    address: "0x470F09ae20163d5E243F6530fb328912A8Fcb099",
    network: "mainnet",
    token: { name: "T", symbol: "T", decimals: 18, totalSupply: "1" },
    findings,
    passed: count("pass"),
    total: findings.length,
    counts: { pass: count("pass"), warn: count("warn"), fail: count("fail"), unknown: count("unknown") },
    explorerReachable: true,
    degraded: false,
    blockNumber: "23832458",
    generatedAt: "2026-10-02T06:00:00.000Z",
    ...over,
  };
}

describe("summarize", () => {
  it("keeps the counts, and sets liquid from the liquidity finding and passing from five passes", () => {
    const r = report(["pass", "pass", "pass", "pass", "warn", "pass", "unknown", "fail"]);
    expect(summarize(r, at(7), 1)).toEqual({
      summary: { passed: 5, total: 8, counts: { pass: 5, warn: 1, fail: 1, unknown: 1 }, block: 23_832_458, at: at(7) },
      radar: { liquid: true, passing: true },
    });
  });

  it("is neither liquid nor passing on a thin token with four passes", () => {
    expect(summarize(report(["pass", "pass", "pass", "pass", "pass", "warn", "unknown", "unknown"]), at(7), 1).radar).toEqual({ liquid: false, passing: true });
    expect(summarize(report(["pass", "pass", "pass", "unknown", "warn", "pass", "unknown", "fail"]), at(7), 1).radar).toEqual({ liquid: true, passing: false });
  });

  it("falls back to the block it was given when the report couldn't read one", () => {
    expect(summarize(report(["pass"], { blockNumber: "unknown" }), at(7), 23_000_000).summary.block).toBe(23_000_000);
  });
});

describe("bestPoolOf", () => {
  const v3: Pool = { address: "0x2982e0FED1815f130110B60c82339Db9A4731677", version: "v3", quote: "USDC", depth: 900_000_000n, liquid: false };
  const v4: Pool = {
    address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", version: "v4", quote: "USDC", depth: 2_000_000_000n, liquid: true,
    poolId: `0x${"9E".repeat(32)}`,
  };
  const scan = (pools: Pool[]): PoolScan => ({ pools, factoriesAnswered: true, silent: [] });

  it("names the pool the liquidity finding names: a v4 pool by its id, the others by address, lowercase", () => {
    expect(bestPoolOf(scan([v3, v4]))).toEqual({ id: `0x${"9e".repeat(32)}`, version: "v4", depthUsdc: "2000000000" });
    expect(bestPoolOf(scan([v3]))).toEqual({ id: "0x2982e0fed1815f130110b60c82339db9a4731677", version: "v3", depthUsdc: "900000000" });
  });

  it("is null when the lookup found no pool, and undefined (keep what is stored) when it failed", () => {
    expect(bestPoolOf(scan([]))).toBeNull();
    expect(bestPoolOf(null)).toBeUndefined();
  });
});
