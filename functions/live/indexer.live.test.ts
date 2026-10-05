/**
 * The indexer's chain reads against Arc mainnet, read-only: the finalized head, one full 10,000-block window of the
 * combined filter, and one window a block too wide. Three calls, paced 400 ms apart like a run's. It checks what the unit
 * tests assume of the node: the window cap, the refusal's shape, and that a recent window decodes into pools worth
 * recording (about 3 a minute on 2026-09-29, F17).
 */
import { describe, expect, it } from "vitest";
import { decodeLogs, sourcesFor } from "../src/indexer/events";
import { selectPool } from "../src/indexer/pools";
import { RangeRefused, rpcLogChain } from "../src/indexer/rpc";
import { INDEXER_RPC_URL } from "../src/indexer/schedule";
import { MAX_WINDOW } from "../src/indexer/windows";

const chain = rpcLogChain(INDEXER_RPC_URL);
const sources = sourcesFor("mainnet");
const filter = { addresses: sources.map((s) => s.address), topic0s: sources.map((s) => s.topic0) };

describe("the indexer's reads on Arc mainnet", () => {
  it("reads a full window at the finalized head, and finds qualifying pools in it", async () => {
    const head = await chain.head();
    expect(head).toBeGreaterThan(23_800_000);
    const logs = await chain.logs({ ...filter, from: head - MAX_WINDOW + 1, to: head });
    const sightings = decodeLogs(logs, sources);
    expect(sightings.length).toBe(logs.length); // every log the filter returns is one the indexer reads
    const pools = sightings.flatMap((s) => (s.kind === "pool" ? [selectPool(s, "mainnet")] : [])).filter((p) => p !== null);
    expect(pools.length).toBeGreaterThan(10);
    expect(sightings.every((s) => s.timestamp !== null)).toBe(true); // Arc sends blockTimestamp
    console.info(`window ${head - MAX_WINDOW + 1}-${head}: ${logs.length} logs, ${pools.length} qualifying pools`);

    await expect(chain.logs({ ...filter, from: head - MAX_WINDOW, to: head })).rejects.toBeInstanceOf(RangeRefused);
  });
});
