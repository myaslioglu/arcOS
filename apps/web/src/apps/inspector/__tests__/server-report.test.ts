import { describe, expect, it, vi } from "vitest";
import { inspectChain } from "@arcos/chain";
import { DEADLINE_MS, type Report } from "@arcos/inspector";
import { passLine } from "@/lib/proof";
import { BUSY, LIMITED, NOT_HERE, NO_CONTRACT, SERVER_TIMEOUT_MS, ServerReportError, UNREACHABLE, UNREADABLE, asReport, serverReport } from "../server-report";

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
    const got = await serverReport(BASE, TOKEN, { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(`/api/inspect/base/${TOKEN}`, { headers: { accept: "application/json" }, signal: expect.any(AbortSignal) });
    expect(got).toMatchObject({ address: TOKEN, chain: "base", chainId: 8453, passed: 1, total: 2 });
    expect(got.findings.map((f) => [f.id, f.status])).toEqual([
      ["verified", "pass"],
      ["holders", "fail"],
    ]);
  });

  it("offers no fix off Arc: Vault and Vesting are Arc's apps", async () => {
    const got = await serverReport(BASE, TOKEN, { fetchFn: answering(200, report()) });
    expect(got.findings.every((f) => f.fixAppId === null)).toBe(true);
  });

  it("says what each refusal means, in its own words", async () => {
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: answering(404, { error: "No contract at that address." }) }))).toBe(NO_CONTRACT);
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: answering(404, { error: "Not available on this network." }) }))).toBe(NOT_HERE);
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: answering(503, { error: "busy" }) }))).toBe(BUSY);
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: answering(429, { error: "slow down" }) }))).toBe(LIMITED);
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: answering(502, { error: "https://node.example/v2/secret" }) }))).toBe(UNREACHABLE);
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: down }))).toBe(UNREACHABLE);
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
      expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: answering(200, body) })), JSON.stringify(body)).toBe(UNREADABLE);
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

  it("counts what it shows from the findings, never from the body's own numbers", () => {
    const got = asReport(
      report({
        findings: [
          { id: "verified", status: "fail", title: "a", detail: "b", evidenceUrl: null, fixAppId: null },
          { id: "holders", status: "fail", title: "a", detail: "b", evidenceUrl: null, fixAppId: null },
          { id: "trade", status: "unknown", title: "a", detail: "b", evidenceUrl: null, fixAppId: null },
        ],
        passed: 2,
        total: 2,
        counts: { pass: 2, warn: 0, fail: 0, unknown: 0 },
      }),
      BASE,
      TOKEN,
    ) as Report;
    expect(got).toMatchObject({ passed: 0, total: 3, counts: { pass: 0, warn: 0, fail: 2, unknown: 1 } });
    expect(passLine(got)).toBe("0 of 3 checks pass · 1 couldn't be checked");
  });

  it("refuses a body with a check in it twice, whose rows would share a key", async () => {
    const twice = report({
      findings: [
        { id: "verified", status: "pass", title: "a", detail: "b", evidenceUrl: null, fixAppId: null },
        { id: "verified", status: "fail", title: "a", detail: "b", evidenceUrl: null, fixAppId: null },
      ],
    });
    expect(asReport(twice, BASE, TOKEN)).toBeNull();
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: answering(200, twice) }))).toBe(UNREADABLE);
  });

  it("takes the block and the time in the shapes the window shows them, and refuses others", () => {
    expect(asReport(report({ blockNumber: "unknown" }), BASE, TOKEN)?.blockNumber).toBe("unknown");
    expect(asReport(report({ generatedAt: "2026-11-28T06:05Z" }), BASE, TOKEN)?.generatedAt).toBe("2026-11-28T06:05Z");
    for (const over of [{ blockNumber: "1".repeat(21) }, { blockNumber: "12 345" }, { blockNumber: 1 }, { generatedAt: "x" }, { generatedAt: "2026-11-28 06:05" }]) {
      expect(asReport(report(over), BASE, TOKEN), JSON.stringify(over)).toBeNull();
    }
  });
});

describe("serverReport's request", () => {
  /** A fetch that answers only when its signal ends it, as a stalled connection does, rejecting with the signal's reason. */
  const stalled = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );

  it("waits longer than the server's own deadline for an inspection", () => {
    expect(SERVER_TIMEOUT_MS).toBeGreaterThan(DEADLINE_MS);
  });

  it("stops after its timeout, and says it couldn't reach the network", async () => {
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: stalled, timeoutMs: 20 }))).toBe(UNREACHABLE);
    expect(stalled.mock.lastCall![1]!.signal!.aborted).toBe(true);
  });

  it("says the same of an answer whose body stalls past the timeout", async () => {
    const slowBody = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init!.signal!;
      const json = () => new Promise<unknown>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { ok: true, status: 200, json } as unknown as Response;
    });
    expect(await failure(() => serverReport(BASE, TOKEN, { fetchFn: slowBody, timeoutMs: 20 }))).toBe(UNREACHABLE);
  });

  it("ends with the caller's signal, and passes the caller's reason on, which is no answer to show", async () => {
    const caller = new AbortController();
    const pending = serverReport(BASE, TOKEN, { fetchFn: stalled, signal: caller.signal });
    caller.abort();
    const reason = await pending.catch((e: unknown) => e);
    expect(reason).toBe(caller.signal.reason);
    expect(reason).not.toBeInstanceOf(ServerReportError);
    expect((reason as Error).name).toBe("AbortError");
  });
});
