import { describe, expect, it, vi } from "vitest";
import { StatsFetchError, fetchStats, isGone, parseStatsAnswer, statsQueryOptions } from "../api";

const SERVED = Date.parse("2026-11-08T12:00:30Z");
const answer = (over: Record<string, unknown> = {}) => ({
  version: 1,
  network: "arc-mainnet",
  asOf: { block: 24_012_345, at: "2026-11-08T12:00:00.000Z", behind: 12 },
  counts: [
    {
      id: "tokens_created",
      label: "Tokens created with Mint",
      value: 1234,
      since: "2026-09-25",
      source: "onchain",
      parts: [{ id: "standard", label: "Standard", value: 1000 }],
      verify: { event: "TokenCreated(...)", how: "Count.", contracts: [{ label: "TokenFactory", address: "0xa68e", explorer: "https://explorer.arc.io/address/0xa68e?tab=logs" }] },
    },
    { id: "wallets_signed_in", label: "Wallets signed in", value: 212, since: "2026-10-14", source: "server" },
  ],
  notes: ["Automated counts."],
  ...over,
});

describe("parseStatsAnswer", () => {
  it("reads a good answer: counts with parts and explorer links, the block, its time and the server's time", () => {
    const list = parseStatsAnswer(answer(), SERVED);
    expect(list.asOf).toEqual({ block: 24_012_345, atMs: Date.parse("2026-11-08T12:00:00.000Z"), behind: 12 });
    expect(list.servedAt).toBe(SERVED);
    expect(list.items.map((i) => [i.id, i.value, i.since, i.source])).toEqual([
      ["tokens_created", 1234, "2026-09-25", "onchain"],
      ["wallets_signed_in", 212, "2026-10-14", "server"],
    ]);
    expect(list.items[0]?.parts).toEqual([{ id: "standard", label: "Standard", value: 1000 }]);
    expect(list.items[0]?.links).toEqual([{ label: "TokenFactory", href: "https://explorer.arc.io/address/0xa68e?tab=logs" }]);
    expect(list.items[1]?.links).toEqual([]);
    expect(list.notes).toEqual(["Automated counts."]);
  });

  it("drops a count whose id, label, value or source isn't right, and a repeated id", () => {
    const good = (answer().counts as unknown[])[0] as Record<string, unknown>;
    const list = parseStatsAnswer(
      answer({
        counts: [
          { ...good, id: 7 },
          { ...good, label: "‮​" },
          { ...good, value: -1 },
          { ...good, value: 1.5 },
          { ...good, value: "12" },
          { ...good, source: "browser" },
          null,
          "x",
          good,
          { ...good, value: 99 },
        ],
      }),
    );
    expect(list.items.map((i) => [i.id, i.value])).toEqual([["tokens_created", 1234]]);
  });

  it("reads a field that isn't right as nothing: a date, a part, a link that isn't https", () => {
    const list = parseStatsAnswer(
      answer({
        counts: [
          {
            id: "drops",
            label: "Drop transactions",
            value: 3,
            since: "yesterday",
            source: "onchain",
            parts: [{ id: "a", label: "A", value: -2 }, { id: "b", label: "B", value: 2 }, "x"],
            verify: { contracts: [{ label: "A", explorer: "javascript:alert(1)" }, { label: "B", explorer: "http://explorer.arc.io/x" }, { label: "C", explorer: "not a url" }, { label: "D", explorer: "https://explorer.arc.io/d" }] },
          },
        ],
      }),
    );
    expect(list.items[0]?.since).toBeNull();
    expect(list.items[0]?.parts).toEqual([{ id: "b", label: "B", value: 2 }]);
    expect(list.items[0]?.links).toEqual([{ label: "D", href: "https://explorer.arc.io/d" }]);
  });

  it("cleans labels again: no control or bidi characters, bounded", () => {
    const list = parseStatsAnswer(answer({ counts: [{ id: "x", label: `A‮B\n${"c".repeat(200)}`, value: 1, source: "server" }] }));
    expect(list.items[0]?.label).toBe(`AB${"c".repeat(58)}`);
  });

  it("reads no time and no block as no 'as of', and an empty list before counting began", () => {
    expect(parseStatsAnswer(answer({ asOf: null, counts: [] })).asOf).toBeNull();
    expect(parseStatsAnswer(answer({ asOf: { block: 5, at: "later" } })).asOf).toBeNull();
    expect(parseStatsAnswer(answer({ asOf: { block: -5, at: "2026-11-08T12:00:00Z" } })).asOf).toBeNull();
    expect(parseStatsAnswer(answer({ asOf: { block: 5, at: "2026-11-08T12:00:00Z" } })).asOf?.behind).toBe(0);
  });

  it("throws on anything but an answer of version 1", () => {
    for (const bad of [null, "x", 7, [], {}, { version: 2, counts: [] }, { version: 1 }, { version: 1, counts: "x" }]) {
      expect(() => parseStatsAnswer(bad), JSON.stringify(bad)).toThrow(StatsFetchError);
    }
  });
});

describe("fetchStats", () => {
  const respond = (body: unknown, init: ResponseInit = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, ...init })) as unknown as typeof fetch;

  it("asks /api/stats, and measures ages on the server's Date header", async () => {
    const fetchFn = respond(answer(), { headers: { date: "Sun, 08 Nov 2026 12:00:30 GMT" } });
    const list = await fetchStats(fetchFn);
    expect(fetchFn).toHaveBeenCalledWith("/api/stats", expect.objectContaining({ signal: expect.anything() as AbortSignal }));
    expect(list.servedAt).toBe(SERVED);
  });

  it("falls back to this device's clock without a usable Date header", async () => {
    const before = Date.now();
    const list = await fetchStats(respond(answer()));
    expect(list.servedAt).toBeGreaterThanOrEqual(before);
  });

  it("throws StatsFetchError with the status, or null for no answer and for a body that isn't one", async () => {
    const status = async (s: number) => fetchStats(vi.fn(async () => new Response("{}", { status: s })) as unknown as typeof fetch).catch((e: unknown) => e);
    expect(await status(404)).toMatchObject({ name: "StatsFetchError", status: 404 });
    expect(await status(503)).toMatchObject({ status: 503 });
    expect(await fetchStats(vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch).catch((e: unknown) => e)).toMatchObject({ status: null });
    expect(await fetchStats(vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch).catch((e: unknown) => e)).toMatchObject({ status: null });
    expect(await fetchStats(respond({ version: 9 })).catch((e: unknown) => e)).toMatchObject({ status: null });
  });
});

describe("isGone", () => {
  it("is true for a 404 only", () => {
    expect(isGone(new StatsFetchError(404))).toBe(true);
    expect(isGone(new StatsFetchError(503))).toBe(false);
    expect(isGone(new StatsFetchError(null))).toBe(false);
    expect(isGone(new Error("404"))).toBe(false);
  });
});

describe("statsQueryOptions", () => {
  it("polls every 60 s, not in the background, never after a 404, and does not retry", () => {
    const opts = statsQueryOptions(true);
    expect(opts.queryKey).toEqual(["stats"]);
    expect(opts.enabled).toBe(true);
    expect(opts.refetchIntervalInBackground).toBe(false);
    expect(opts.retry).toBe(false);
    const interval = opts.refetchInterval as (q: { state: { error: unknown } }) => number | false;
    expect(interval({ state: { error: null } })).toBe(60_000);
    expect(interval({ state: { error: new StatsFetchError(503) } })).toBe(60_000);
    expect(interval({ state: { error: new StatsFetchError(404) } })).toBe(false);
    expect(statsQueryOptions(false).enabled).toBe(false);
  });
});
