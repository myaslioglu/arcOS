/**
 * Live, read-only checks of check 10 against Arc mainnet: TradeSimulator's runtime code, placed at a throwaway address with an
 * eth_call state override, buying and selling back against real pools of every kind it swaps through. A forge fork can't move
 * Arc's 0x3600 USDC (its balances move through precompiles revm lacks), so this is where the USDC path is measured. Each case
 * is one gas-capped eth_call after the pool lookup; no transaction is sent and no key is used.
 *
 * Market state moves, so each token below records what it showed when it was picked (Arc mainnet, around block 23,835,700,
 * 2026-10-02). An established pool should keep answering the same way. A launch token's pool can be drained or its owner can
 * change a rule; if one of those cases starts failing, check the token again and pick another from the same kind of pool
 * (Uniswap v2 `allPairs`, v3 `PoolCreated`, v4 `Initialize` logs).
 */
import { describe, expect, it } from "vitest";
import { DEX, EURC, UNISWAP_V4, USDC, type DexConfig } from "@arcos/chain";
import { checkTrade, findPools } from "../src/checks";
import { inspect } from "../src/inspect";
import { simulateTrade, simulatorAddresses, STATUS } from "../src/simulate";
import type { InspectInput, PoolScan } from "../src/types";
import { reader } from "./arc";

const input = (address: `0x${string}`, dex: DexConfig | null = DEX.mainnet): InspectInput => ({
  address, network: "mainnet", reader, explorer: null, dex, knownLockers: [], explorerBase: "https://explorer.arc.io",
});
const m = DEX.mainnet!;
const v2Only: DexConfig = { quoteTokens: m.quoteTokens, v2Factory: m.v2Factory };
const v3Only: DexConfig = { quoteTokens: m.quoteTokens, v3Factory: m.v3Factory, v3FeeTiers: m.v3FeeTiers };
const v4Only: DexConfig = { quoteTokens: m.quoteTokens, v4: UNISWAP_V4 };
const lower = (a: string) => a.toLowerCase();

/** The round trip `simulateTrade` ran in the first pool it measured, failing the test with what it got instead. */
async function ran(address: `0x${string}`, dex: DexConfig) {
  const scan: PoolScan = await findPools(input(address, dex));
  const measured = await simulateTrade(reader, address, scan);
  const run = measured.kind === "measured" ? measured.attempts[0] : undefined;
  if (run?.kind !== "ran") throw new Error(`no round trip for ${address}: ${run?.kind ?? measured.kind}`);
  return { scan, run };
}

/** Loss in parts per million of what was spent. */
const lossPpm = (r: { spent: bigint; received: bigint }) => (r.received >= r.spent ? 0n : ((r.spent - r.received) * 1_000_000n) / r.spent);

// --- Honest tokens: each pool kind's swap path, end to end ---

/** Uniswap v2 pair 0x174bEdc3…a6A9 with about 233,000 USDC: 10 USDC came back as 9.940092 (0.6%, the two 0.3% fees). */
const V2_HONEST = "0x8c4252c87081c88c6ad57d6dd97e1cafebf842b7";
/** WETH, through the Aerodrome Slipstream pool 0x6F30…96FC (Uniswap v3's swap and callback): 10 USDC came back as 9.989202. */
const WETH = "0x128cC466B61f542da60c70e3aA11c10e19B84EDB";
/** A launch token with a Uniswap v3 1% pool, 0x8DB1…5af9, holding about 259 USDC: 0.258933 USDC came back as 0.253779 (2%). */
const V3_TOKEN = "0xa2B9970D18d7Cd8ad994110DA761b9E967Eb5172";
/** A launch token with a hookless native-USDC v4 pool (0.25%, spacing 50, `Initialize` at block 23,834,395): 0.021037 USDC
 * came back as 0.020931 (0.5%). */
const V4_NATIVE_TOKEN = "0x57de270c1fE7dcc88e2E1ea7Af866D84061f7FC0";

// --- Tokens that take more, or can't be sold ---

/** A Uniswap v2 token (pair 0xDd58…d43b, about 3,700 USDC) that takes about 5% each way: 3.704163 USDC came back as 3.32332, 10.3%. */
const TAX_TOKEN = "0xe60e2bcd092b78092a4a4010de1ccaadf5c03cca";
/** A Uniswap v2 token (pair 0xE3aE…7475, 27 USDC) whose sell reverts with "Sell restricted: not whitelisted": buys go
 * through, and only addresses its owner lists can sell. */
const SELL_WHITELIST_TOKEN = "0xdb07d187ed6ba6790ec1fc473a386fa1106db697";

/** A launch token whose only USDC pool is a Uniswap v3 1% pool, 0xf74B…3939, with about 1,692 USDC (block 23,840,329):
 * 1.6916 USDC buys it, and selling straight back into the same pool reverts. With no Uniswap v2 or hookless v4 pool to try
 * instead, it fails. The warning case has no live example yet: no token with a Uniswap v3 USDC pool also had a Uniswap v2
 * USDC pair with 1 USDC or more in both, and the 300 newest hooked v4 USDC pools all sold back. */
const V3_SELL_REVERTS = "0x786a352a5ad3905fe2ff4c0849fa8da849281991";

describe("check 10 on Arc mainnet, read-only", () => {
  it("places the simulator and its router at fresh addresses with no code of their own", async () => {
    const { simulator, router } = simulatorAddresses();
    expect(await reader.getCode(simulator)).toBeNull();
    expect(await reader.getCode(router)).toBeNull();
  });

  it("reads a gas price for the call, which the simulator's balance prepays", async () => {
    expect(await reader.gasPrice()).toBeGreaterThan(0n);
  });

  it("round-trips an honest token through a Uniswap v2 pair for no more than the pair's two fees", async () => {
    const { run } = await ran(V2_HONEST, v2Only);
    expect(run.pool.version).toBe("v2");
    expect(run.result.status).toBe(STATUS.ok);
    expect(run.result.spent).toBe(10_000_000n);
    expect(run.result.sold).toBe(run.result.bought);
    expect(lossPpm(run.result)).toBeLessThanOrEqual(6_100n);
  });

  it("round-trips WETH through Aerodrome Slipstream, Uniswap v3's swap and callback", async () => {
    const { run } = await ran(WETH, DEX.mainnet!);
    expect(run.pool.version).toBe("aero");
    expect(run.result.status).toBe(STATUS.ok);
    expect(lossPpm(run.result)).toBeLessThan(10_000n);
  });

  it("round-trips a token through a Uniswap v3 pool for about its two 1% fees", async () => {
    const { run } = await ran(V3_TOKEN, v3Only);
    expect(run.pool).toMatchObject({ version: "v3", fee: 10000 });
    expect(run.result.status).toBe(STATUS.ok);
    expect(lossPpm(run.result)).toBeLessThanOrEqual(20_500n);
  });

  it("round-trips EURC through the established USDC/EURC v4 pool, paying the USDC ERC-20 into the PoolManager", async () => {
    const { run } = await ran(EURC.mainnet, v4Only);
    expect(run.pool.version).toBe("v4");
    expect(run.pool.key!.currency0).toBe(USDC);
    expect(run.decimals).toBe(6);
    expect(run.result.status).toBe(STATUS.ok);
    expect(lossPpm(run.result)).toBeLessThan(5_000n);
  });

  it("round-trips a token through a native-USDC v4 pool, paying native USDC in 18 decimals", async () => {
    const { run } = await ran(V4_NATIVE_TOKEN, v4Only);
    expect(run.pool.version).toBe("v4");
    expect(lower(run.pool.key!.currency0)).toBe("0x0000000000000000000000000000000000000000");
    expect(run.decimals).toBe(18);
    expect(run.result.status).toBe(STATUS.ok);
    expect(lossPpm(run.result)).toBeLessThan(10_000n);
  });

  it("warns on a token that takes about 5% each way, and says how much a round trip loses", async () => {
    const scan = await findPools(input(TAX_TOKEN, v2Only));
    const f = await checkTrade(input(TAX_TOKEN, v2Only), scan);
    expect(f).toMatchObject({ id: "trade", status: "warn" });
    expect(f.title).toMatch(/^A round trip loses (9|10|11)\.\d%$/);
  });

  it("fails a token whose sells only its owner's list may make: the buy goes through, the sell reverts", async () => {
    const scan = await findPools(input(SELL_WHITELIST_TOKEN, v2Only));
    const f = await checkTrade(input(SELL_WHITELIST_TOKEN, v2Only), scan);
    expect(f).toMatchObject({ id: "trade", status: "fail", title: "Can't be sold" });
  });

  it("fails a token whose sell reverts in its only pool, a Uniswap v3 pool, and says why such a pool can refuse it", async () => {
    const scan = await findPools(input(V3_SELL_REVERTS));
    const f = await checkTrade(input(V3_SELL_REVERTS), scan);
    expect(f).toMatchObject({ id: "trade", status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(/Uniswap v3 pools refuse a token that arrives short \(a transfer tax\)/);
    expect(f.detail).toMatch(/no Uniswap v2 or hookless Uniswap v4 USDC pool that trades to try selling into instead/);
  });

  it("inspects the honest v2 token end to end: check 10 passes in the report", async () => {
    const report = await inspect(input(V2_HONEST));
    expect(report.total).toBe(9);
    const trade = report.findings.find((f) => f.id === "trade")!;
    expect(trade.status).toBe("pass");
    expect(trade.title).toBe("Bought and sold back in a simulation");
  });
});
