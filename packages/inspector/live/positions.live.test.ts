/**
 * Live, read-only: the lp-lock check over real Uniswap v4 pools on Arc mainnet, with the position lists built here the way
 * the indexer builds them (the PoolManager's `ModifyLiquidity` logs), but for a handful of pools and over each pool's own
 * lifetime. Not part of `npm test`; run it with `npm run test:live -w @arcos/inspector` (behind an HTTP proxy, with
 * `NODE_USE_ENV_PROXY=1`). Only eth_call, eth_getCode, eth_getLogs and eth_blockNumber are sent, one at a time, 400 ms apart.
 *
 * The tokens come from the site's Radar (the newest v4 tokens), or from LP_LOCK_TOKENS (comma-separated addresses). A
 * token's pools are found by their `Initialize` logs, looked for in the last LP_LOCK_LOOKBACK windows of 10,000 blocks (6
 * unless set: about 8 hours), so an older token needs a larger number and takes two requests a window.
 * What it prints is the result table; what it asserts is what must hold of any token: the finding is one of the four
 * the check can give, a pass rests on at least 950 USDC burned or locked, and a fail or a warning offers Vault.
 */
import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DEX, UNISWAP_V4, type Address } from "@arcos/chain";
import { SHARE_SCALE, checkLpLock, findPools, tallyLiquidity, type LiquiditySums } from "../src/checks";
import type { ExtraPool, InspectInput, V4PositionIndex } from "../src/types";
import { MODIFY_LIQUIDITY_TOPIC, positionFromLog } from "../src/v4-positions";
import { v4PoolId } from "../src/v4";
import { arcFields } from "../src/__tests__/fixtures/arc";
import { reader } from "./arc";

const WINDOW = 10_000n;
const LOOKBACK_WINDOWS = Number(process.env.LP_LOCK_LOOKBACK ?? 6);
const TOKENS = 6;
const initializeAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const INITIALIZE = toEventSelector(initializeAbi[0]);
const topicOf = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

async function radarTokens(): Promise<Address[]> {
  const given = process.env.LP_LOCK_TOKENS?.split(",").map((a) => a.trim()).filter(Boolean);
  if (given?.length) return given as Address[];
  const res = await fetch("https://4rcos.com/api/radar", { signal: AbortSignal.timeout(20_000) });
  const { rows } = (await res.json()) as { rows: { address: Address; source: string }[] };
  return rows.filter((r) => r.source === "v4").slice(0, TOKENS).map((r) => r.address);
}

/** The token's v4 pools initialised in the last `LOOKBACK_WINDOWS` windows, as index entries, with each one's block. */
async function initialized(token: Address, head: bigint): Promise<{ pool: ExtraPool; id: Hex; block: bigint }[]> {
  const found: { pool: ExtraPool; id: Hex; block: bigint }[] = [];
  for (let i = 0, to = head; i < LOOKBACK_WINDOWS && to > 0n; i++, to -= WINDOW) {
    const fromBlock = to - WINDOW + 1n > 0n ? to - WINDOW + 1n : 0n;
    for (const topics of [[INITIALIZE, null, topicOf(token)], [INITIALIZE, null, null, topicOf(token)]] as const) {
      for (const log of await reader.logs({ address: UNISWAP_V4.poolManager, topics, fromBlock, toBlock: to })) {
        const { args } = decodeEventLog({ abi: initializeAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        const key = { currency0: args.currency0, currency1: args.currency1, fee: args.fee, tickSpacing: args.tickSpacing, hooks: args.hooks };
        found.push({ pool: { version: "v4", key }, id: v4PoolId(key), block: log.blockNumber });
      }
    }
  }
  return found;
}

/** The pool's position keys from its `ModifyLiquidity` logs over [from, to], in windows of 10,000 blocks. */
async function positionsOf(id: Hex, from: bigint, to: bigint) {
  const keys = new Map<string, NonNullable<ReturnType<typeof positionFromLog>>["key"]>();
  for (let start = from; start <= to; start += WINDOW) {
    const end = start + WINDOW - 1n < to ? start + WINDOW - 1n : to;
    for (const log of await reader.logs({ address: UNISWAP_V4.poolManager, topics: [MODIFY_LIQUIDITY_TOPIC, id], fromBlock: start, toBlock: end })) {
      const position = positionFromLog(log);
      if (position) keys.set(JSON.stringify(position.key), position.key);
    }
  }
  return [...keys.values()];
}

describe("lp-lock over real v4 pools, read-only", () => {
  it("answers for the newest v4 tokens on Radar from their positions", async () => {
    const tokens = await radarTokens();
    expect(tokens.length).toBeGreaterThan(0);
    const rows: Record<string, unknown>[] = [];
    for (const address of tokens) {
      const head = await reader.blockNumber();
      const pools = await initialized(address, head);
      // The index as the indexer would hold it a few blocks ago: the check reads the rest of the way itself.
      const cursor = head - 20n;
      const index: V4PositionIndex = { cursor: Number(cursor), pools: {} };
      for (const { id, block } of pools) index.pools[id.toLowerCase()] = { positions: await positionsOf(id, block, cursor), truncated: false };
      const input: InspectInput = {
        ...arcFields("mainnet"),
        address, network: "mainnet", reader, explorer: null, dex: DEX.mainnet, knownLockers: [], explorerBase: "https://explorer.arc.io",
        extraPools: pools.map((p) => p.pool),
        v4Positions: index,
      };
      // The standard hookless keys the scan also probes have no entry above; one that exists reads as "missing".
      const scan = await findPools(input);
      for (const p of scan.pools) if (p.version === "v4" && p.poolId && !index.pools[p.poolId.toLowerCase()]) index.pools[p.poolId.toLowerCase()] = { positions: [], truncated: false };
      const finding = await checkLpLock(input, scan);
      // Null: no v4 pool is involved (the index built above is 20 blocks behind, so it is never stale).
      const tally = await tallyLiquidity(input, scan, DEX.mainnet!);
      const units = (scaled: bigint) => Number(scaled / SHARE_SCALE) / 1e6;
      const sums = (m: LiquiditySums) => ({ burned: units(m.burned), locked: units(m.locked), withdrawable: units(m.withdrawable), unknown: Object.fromEntries(Object.entries(m.unknown).filter(([, v]) => v > 0n).map(([k, v]) => [k, units(v)])) });
      expect(["pass", "warn", "fail", "unknown"]).toContain(finding.status);
      if (finding.status === "pass" && tally) expect((tally.now.burned + tally.now.locked) / SHARE_SCALE).toBeGreaterThanOrEqual(950_000_000n);
      if (finding.status === "fail" || finding.status === "warn") expect(finding).toMatchObject({ fixAppId: "vault" });
      rows.push({
        token: address,
        pools: scan.pools.map((p) => `${p.version}${p.key && BigInt(p.key.hooks) !== 0n ? `+hook ${p.key.hooks}` : ""} ${p.poolId ?? p.address}`),
        positions: Object.fromEntries(Object.entries(index.pools).map(([id, v]) => [id.slice(0, 10), v.positions.length])),
        now: tally && sums(tally.now),
        ahead: tally && sums(tally.ahead),
        blockers: tally?.blockers,
        status: finding.status,
        title: finding.title,
        detail: finding.detail,
        evidence: finding.evidenceUrl,
      });
    }
    console.log(JSON.stringify(rows, null, 2));
  });
});
