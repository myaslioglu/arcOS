/**
 * The usage counter's chain reads against Arc mainnet, read-only: one 10,000-block window from the FeeController's
 * deployment (history, so the numbers below never change), decoded and folded the way a run does. Run with
 * `npm run test:live -w @arcos/functions`; never part of `npm test` or CI. Behind an HTTP proxy, set NODE_USE_ENV_PROXY=1.
 */
import { describe, expect, it } from "vitest";
import { STATS_FROM } from "@arcos/chain";
import { rpcLogChain } from "../src/indexer/rpc";
import { INDEXER_RPC_URL } from "../src/indexer/schedule";
import { decodeStatsLogs, emptyStatsState, foldStats, statsSources } from "../src/indexer/stats";
import { MAX_WINDOW } from "../src/indexer/windows";

const chain = rpcLogChain(INDEXER_RPC_URL);
const sources = statsSources("mainnet");
const filter = { addresses: sources.map((s) => s.address), topic0s: [...new Set(sources.map((s) => s.topic0))] };

describe("the usage counter's reads on Arc mainnet", () => {
  it("decodes every log of the first window from the FeeController's deployment and folds it", async () => {
    const from = STATS_FROM.mainnet!.block;
    const window = { from, to: from + MAX_WINDOW - 1 };
    const logs = await chain.logs({ ...filter, ...window });
    const events = decodeStatsLogs(logs, sources, window);
    expect(events.length).toBe(logs.length); // every log the filter returns is one Stats reads
    expect(events.every((e) => e.timestamp !== null)).toBe(true); // Arc sends blockTimestamp
    const kinds = (kind: string) => events.filter((e) => e.kind === kind).length;
    const { state, delta, days } = foldStats(emptyStatsState(), events, []);
    console.info(
      `window ${window.from}-${window.to}: ${logs.length} logs: ${kinds("fee")} fee, ${kinds("tokenCreated")} TokenCreated, ${kinds("drop")} Drop; ` +
        `totals ${JSON.stringify({ ...state.totals, feesMint: String(state.totals.feesMint), feesDrop: String(state.totals.feesDrop) })}, fees ${JSON.stringify(state.fees, (_, v: unknown) => (typeof v === "bigint" ? String(v) : v))}, days ${[...days.keys()].join(",")}`,
    );
    expect(kinds("fee")).toBeGreaterThanOrEqual(3); // KeyAdded for MINT_FLAT, DROP_PER_RECIPIENT and DROP_MIN
    expect(state.fees.mintFlat).not.toBeNull();
    expect(delta.tokensCreated).toBe(kinds("tokenCreated"));
  });

  it("decodes a window around a known Mint (block 22,847,865): the fee change before it, the TokenCreated, and no Drop", async () => {
    const window = { from: 22_847_000, to: 22_848_999 };
    const logs = await chain.logs({ ...filter, ...window });
    const events = decodeStatsLogs(logs, sources, window);
    expect(events.length).toBe(logs.length);
    const kinds = events.map((e) => `${e.kind}@${e.block}`);
    console.info(`window ${window.from}-${window.to}: ${logs.length} logs: ${kinds.join(", ")}`);
    expect(kinds).toEqual(["fee@22847593", "tokenCreated@22847865"]);
    // Everyone counted: one token at the 1 USDC fee the change set. With the project wallet left out, it is counted apart.
    const everyone = foldStats(emptyStatsState(), events, []);
    expect(everyone.state.totals).toMatchObject({ tokensCreated: 1, drops: 0 });
    expect(foldStats(emptyStatsState(), events).state.excluded).toEqual({ tokensCreated: 1, drops: 0 });
  });
});
