import { describe, expect, it } from "vitest";
import { ARCOS, PREVIOUS_MULTISENDS, USAGE_EVENTS } from "@arcos/chain";
import type { StatsDoc } from "../docs";
import { STATS_NOTES, statsAnswer } from "../stats";
import type { TimestampLike } from "../timestamps";

const at = (ms: number): TimestampLike => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000, toDate: () => new Date(ms), toMillis: () => ms });
const T = Date.parse("2026-11-08T12:00:00Z");

const doc = (over: Partial<StatsDoc> = {}): StatsDoc => ({
  network: "mainnet",
  block: 24_012_345,
  fromBlock: 22_742_796,
  head: 24_012_400,
  fees: { mintFlat: "1000000000000000000", dropPerRecipient: "10000000000000000", dropMin: "2000000000000000000" },
  totals: {
    tokensCreated: 1234,
    byTemplate: { standard: 1000, mintable: 100, burnable: 84, mintableBurnable: 50 },
    drops: 321,
    dropsNative: 200,
    dropsToken: 121,
    rowsSubmitted: 50_000,
    rowsDelivered: 49_900,
    rowsFailed: 100,
    feesMint: "1234000000000000000000",
    feesDrop: "987654321000000000000",
  },
  excluded: { tokensCreated: 7, drops: 9 },
  server: {
    users: 212,
    telegramLinked: 40,
    watches: 95,
    watchedTokens: 60,
    tokensIndexed: 8000,
    tokensInspected: 7500,
    since: { users: at(Date.parse("2026-10-14T08:00:00Z")), watches: at(Date.parse("2026-10-20T08:00:00Z")), tokens: at(Date.parse("2026-10-01T00:30:00Z")) },
    countedAt: at(T - 60_000),
  },
  onchainSince: at(Date.parse("2026-09-25T00:00:00Z")),
  updatedAt: at(T),
  ...over,
});

describe("statsAnswer", () => {
  it("answers no counts and no time before counting began", () => {
    const answer = statsAnswer(null);
    expect(answer).toEqual({ version: 1, network: "arc-mainnet", asOf: null, counts: [], notes: [...STATS_NOTES] });
  });

  it("lists the on-chain counts with their dates, parts and how to check them, then the server counts", () => {
    const answer = statsAnswer(doc());
    expect(answer.version).toBe(1);
    expect(answer.network).toBe("arc-mainnet");
    expect(answer.asOf).toEqual({ block: 24_012_345, at: "2026-11-08T12:00:00.000Z", behind: 55 });
    expect(answer.counts.map((c) => [c.id, c.value, c.since, c.source])).toEqual([
      ["tokens_created", 1234, "2026-09-25", "onchain"],
      ["drops", 321, "2026-09-25", "onchain"],
      ["recipients_delivered", 49_900, "2026-09-25", "onchain"],
      ["rows_failed", 100, "2026-09-25", "onchain"],
      ["wallets_signed_in", 212, "2026-10-14", "server"],
      ["telegram_linked", 40, "2026-10-14", "server"],
      ["watches", 95, "2026-10-20", "server"],
      ["tokens_indexed", 8000, "2026-10-01", "server"],
      ["tokens_inspected", 7500, "2026-10-01", "server"],
    ]);
    const [tokens, drops] = answer.counts;
    expect(tokens?.parts?.map((p) => [p.id, p.value])).toEqual([["standard", 1000], ["mintable", 100], ["burnable", 84], ["mintable_burnable", 50]]);
    expect(tokens?.parts?.reduce((sum, p) => sum + p.value, 0)).toBe(1234);
    expect(drops?.parts?.map((p) => [p.id, p.value])).toEqual([["native", 200], ["token", 121]]);
  });

  it("names the contract, the event and an explorer link for each on-chain count, and none for a server count", () => {
    const answer = statsAnswer(doc());
    const factory = ARCOS.mainnet!.tokenFactory;
    const [tokens, drops, delivered, failed] = answer.counts;
    expect(tokens?.verify).toMatchObject({
      event: USAGE_EVENTS.tokenCreated,
      contracts: [{ label: "TokenFactory", address: factory, explorer: `https://explorer.arc.io/address/${factory}?tab=logs` }],
    });
    // Both Multisends, the current one first.
    for (const count of [drops, delivered, failed]) {
      expect(count?.verify?.event).toBe(USAGE_EVENTS.drop);
      expect(count?.verify?.contracts.map((c) => c.address)).toEqual([ARCOS.mainnet!.multisend, ...PREVIOUS_MULTISENDS.mainnet]);
      for (const c of count?.verify?.contracts ?? []) expect(c.explorer).toBe(`https://explorer.arc.io/address/${c.address}?tab=logs`);
    }
    for (const c of answer.counts.filter((c) => c.source === "server")) expect(c.verify).toBeUndefined();
  });

  it("never carries a fee, a fee total, the left-out wallets' counts or an address other than ArcOS's own contracts", () => {
    const text = JSON.stringify(statsAnswer(doc()));
    expect(text).not.toMatch(/fee|mintFlat|dropMin|dropPerRecipient/i);
    expect(text).not.toContain("excluded");
    expect(text).not.toContain("987654321");
    expect(text).not.toContain("463a81a017326e9029dcca2a2d9aa42599bef12c");
    const own = new Set([ARCOS.mainnet!.tokenFactory, ARCOS.mainnet!.multisend, ...PREVIOUS_MULTISENDS.mainnet].map((a) => a.toLowerCase()));
    for (const found of text.match(/0x[0-9a-fA-F]{40}/g) ?? []) expect(own.has(found.toLowerCase()), found).toBe(true);
  });

  it("leaves the server counts out until they have been taken, and a missing since date as null", () => {
    const none = statsAnswer(doc({ server: null }));
    expect(none.counts.map((c) => c.source)).toEqual(["onchain", "onchain", "onchain", "onchain"]);
    const noSince = statsAnswer(doc({ server: { ...doc().server!, since: { users: null, watches: null, tokens: null } } }));
    expect(noSince.counts.filter((c) => c.source === "server").every((c) => c.since === null)).toBe(true);
  });

  it("reads a damaged count as 0 instead of failing, and never answers a negative or fractional number", () => {
    const damaged = doc({ totals: { ...doc().totals, tokensCreated: -4, drops: Number.NaN, rowsFailed: 7.9, rowsDelivered: "12" as unknown as number } });
    const values = Object.fromEntries(statsAnswer(damaged).counts.map((c) => [c.id, c.value]));
    expect(values).toMatchObject({ tokens_created: 0, drops: 0, rows_failed: 7, recipients_delivered: 0 });
  });

  it("measures how far behind the chain counting is, never under 0", () => {
    expect(statsAnswer(doc({ block: 100, head: 90 })).asOf?.behind).toBe(0);
    expect(statsAnswer(doc({ block: 100, head: 5_100 })).asOf?.behind).toBe(5_000);
  });

  it("states what the counts leave out", () => {
    const notes = statsAnswer(doc()).notes.join(" ");
    expect(notes).toMatch(/project wallet/);
    expect(notes).toMatch(/rows, not unique wallets/);
    expect(notes).toMatch(/mainnet only|Arc mainnet only/i);
    expect(notes).toMatch(/Automated/);
  });
});
