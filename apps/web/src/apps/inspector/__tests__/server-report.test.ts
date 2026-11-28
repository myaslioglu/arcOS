import { describe, expect, it, vi } from "vitest";
import { inspectChain } from "@arcos/chain";
import type { Report } from "@arcos/inspector";
import { BUSY, LIMITED, NOT_HERE, NO_CONTRACT, ServerReportError, UNREACHABLE, UNREADABLE, asReport, serverReport } from "../server-report";

const BASE = inspectChain("mainnet", "base")!;
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  address: TOKEN,
  network: "mainnet",
  chain: "base",
  chainId: 8453,
  token: { name: "USD Coin", symbol: "USDC", decimals: 6, totalSupply: "1000" },
  findings: [
    { id: "verified", status: "pass", title: "Source code is verified", detail: "Anyone can read it.", evidenceUrl: `https://base.blockscout.com/address/${TOKEN}?tab=contract`, fixAppId: null },
    { id: "holders", status: "fail", title: "Top 10 wallets hold 80%", detail: "Excludes pools.", evidenceUrl: null, fixAppId: "vesting" },
  ],
  passed: 1,
  total: 2,
  counts: { pass: 1, warn: 0, fail: 1, unknown: 0 },
  explorerReachable: true,
  degraded: false,
  blockNumber: "1",
  generatedAt: "2026-11-28T00:00:00.000Z",
  ...over,
});

const answering = (status: number, body: unknown) => vi.fn<typeof fetch>(async () => Response.json(body, { status }));
const failure = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(ServerReportError);
    return (e as Error).message;
  }
  return "no error";
};

describe("serverReport", () => {
  it("asks this site's server for the chain's report, and gives it back", async () => {
    const fetchFn = answering(200, report());
    const got = await serverReport(BASE, TOKEN, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(`/api/inspect/base/${TOKEN}`, { headers: { accept: "application/json" } });
    expect(got).toMatchObject({ address: TOKEN, chain: "base", chainId: 8453, passed: 1, total: 2 });
    expect(got.findings.map((f) => [f.id, f.status])).toEqual([
      ["verified", "pass"],
      ["holders", "fail"],
    ]);
  });

  it("offers no fix off Arc: Vault and Vesting are Arc's apps", async () => {
    const got = await serverReport(BASE, TOKEN, answering(200, report()));
    expect(got.findings.every((f) => f.fixAppId === null)).toBe(true);
  });

  it("says what each refusal means, in its own words", async () => {
    expect(await failure(() => serverReport(BASE, TOKEN, answering(404, { error: "No contract at that address." })))).toBe(NO_CONTRACT);
    expect(await failure(() => serverReport(BASE, TOKEN, answering(404, { error: "Not available on this network." })))).toBe(NOT_HERE);
    expect(await failure(() => serverReport(BASE, TOKEN, answering(503, { error: "busy" })))).toBe(BUSY);
    expect(await failure(() => serverReport(BASE, TOKEN, answering(429, { error: "slow down" })))).toBe(LIMITED);
    expect(await failure(() => serverReport(BASE, TOKEN, answering(502, { error: "https://node.example/v2/secret" })))).toBe(UNREACHABLE);
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await failure(() => serverReport(BASE, TOKEN, down))).toBe(UNREACHABLE);
  });

  it("refuses an answer that isn't a report of that token on that chain", async () => {
    for (const body of [
      null,
      "report",
      report({ chain: "arc" }),
      report({ chainId: 1 }),
      report({ address: "0x0000000000000000000000000000000000000001" }),
      report({ findings: [{ id: "nope", status: "pass", title: "x", detail: "y" }] }),
      report({ findings: [{ id: "verified", status: "great", title: "x", detail: "y" }] }),
      report({ counts: { pass: 1 } }),
      report({ explorerSkipped: 5 }),
    ]) {
      expect(await failure(() => serverReport(BASE, TOKEN, answering(200, body))), JSON.stringify(body)).toBe(UNREADABLE);
    }
  });

  it("keeps https evidence links only", () => {
    const got = asReport(
      report({
        findings: [
          { id: "verified", status: "pass", title: "a", detail: "b", evidenceUrl: "javascript:alert(1)", fixAppId: null },
          { id: "proxy", status: "pass", title: "a", detail: "b", evidenceUrl: "http://base.blockscout.com/x", fixAppId: null },
          { id: "holders", status: "pass", title: "a", detail: "b", evidenceUrl: "https://base.blockscout.com/x", fixAppId: null },
        ],
      }),
      BASE,
      TOKEN,
    ) as Report;
    expect(got.findings.map((f) => f.evidenceUrl)).toEqual([null, null, "https://base.blockscout.com/x"]);
  });

  it("keeps the reason a skipped explorer gives", () => {
    const reason = "The explorer wasn't asked: this server has no key for it.";
    expect(asReport(report({ explorerReachable: false, explorerSkipped: reason }), BASE, TOKEN)?.explorerSkipped).toBe(reason);
    expect(asReport(report(), BASE, TOKEN)).not.toHaveProperty("explorerSkipped");
  });
});
