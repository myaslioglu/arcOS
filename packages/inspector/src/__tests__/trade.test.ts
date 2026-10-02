import { describe, expect, it } from "vitest";
import { AERODROME, EURC as EURC_TOKEN, UNISWAP_V4, USDC, tradeSimulatorRuntime, type DexConfig } from "@arcos/chain";
import { checkTrade } from "../checks";
import { inspect } from "../inspect";
import { SIMULATOR, TRADE_GAS } from "../simulate";
import type { InspectInput, Pool, PoolScan } from "../types";
import { NATIVE, v4PoolId, v4PoolKey } from "../v4";
import { fakeChain, type FakeChain, type FakeReader, type SimResult } from "./fixtures/chain-fake";

const TOKEN = "0x1111111111111111111111111111111111111111";
const PAIR = "0x4444444444444444444444444444444444444444";
const POOL = "0x7777777777777777777777777777777777777777";
const EURC_POOL = "0x8888888888888888888888888888888888888888";
const EURC = EURC_TOKEN.mainnet;
const V2 = "0x5555555555555555555555555555555555555555";
const PLAIN = "0x63a9059cbb00";
const HOOK = "0x94f8be2402C0e2eb65F3218a7282A5301371E044";
const DYNAMIC_FEE = 0x800000;

const dex: DexConfig = { quoteTokens: [{ address: USDC, symbol: "USDC" }, { address: EURC, symbol: "EURC" }], v2Factory: V2, v4: UNISWAP_V4, aero: AERODROME };
const input = (reader: FakeReader, d: DexConfig | null = dex): InspectInput => ({
  address: TOKEN, network: "mainnet", reader, explorer: null, dex: d, knownLockers: [], explorerBase: "https://explorer.test",
});
const scanOf = (...pools: Pool[]): PoolScan => ({ pools, factoriesAnswered: true, silent: [] });

const USDC_UNITS = 1_000_000n;
const v2Pool = (depth: bigint, over: Partial<Pool> = {}): Pool => ({ address: PAIR, version: "v2", quote: "USDC", depth, liquid: depth >= 1_000n * USDC_UNITS, ...over });
const v3Pool = (depth: bigint, fee: number): Pool => ({ address: POOL, version: "v3", quote: "USDC", depth, liquid: true, fee });
const aeroPool = (depth: bigint): Pool => ({ address: POOL, version: "aero", quote: "USDC", depth, liquid: true });
const v4Pool = (depth: bigint, quote: `0x${string}`, fee: number, tickSpacing: number, hooks?: `0x${string}`): Pool => {
  const key = v4PoolKey(TOKEN, quote, fee, tickSpacing, hooks);
  return { address: UNISWAP_V4.poolManager, version: "v4", quote: "USDC", depth, liquid: hooks ? null : true, key, poolId: v4PoolId(key), ...(hooks ? { undecided: "hook" as const } : {}) };
};

/** A round trip of `spent` that came back as `received`, every token bought sold. */
const roundTrip = (spent: bigint, received: bigint, bought = 5n * 10n ** 18n): FakeChain["simulation"] => ({
  result: { status: 0, spent, bought, sold: bought, received },
});
const withStatus = (status: number, over: Partial<SimResult> = {}): FakeChain["simulation"] => ({
  result: { status, spent: 10n * USDC_UNITS, bought: 5n * 10n ** 18n, sold: 0n, received: 0n, ...over },
});
const TEN = 10n * USDC_UNITS;

describe("trade simulation: which pool, how much, and the call", () => {
  it("trades against the deepest USDC pool in one eth_call from S to S, with the simulator's code and the USDC at S", async () => {
    const chain = fakeChain({ simulation: roundTrip(TEN, 9_940_000n) });
    await checkTrade(input(chain), scanOf(v2Pool(50_000n * USDC_UNITS), v3Pool(20_000n * USDC_UNITS, 3000)));
    expect(chain.simulations).toHaveLength(1);
    const [sim] = chain.simulations;
    expect(sim!.call).toMatchObject({ from: SIMULATOR, to: SIMULATOR, gas: TRADE_GAS });
    expect(sim!.overrides).toEqual([{ address: SIMULATOR, code: tradeSimulatorRuntime, balance: TEN * 10n ** 12n }]);
    expect(sim!.trade).toMatchObject({ kind: 0, pool: PAIR, token: TOKEN, usdc: USDC, amount: TEN });
  });

  it("tests with 10 USDC, or 0.1% of the pool's depth when that is less", async () => {
    const chain = fakeChain({ simulation: roundTrip(5n * USDC_UNITS, 4_970_000n) });
    await checkTrade(input(chain), scanOf(v2Pool(5_000n * USDC_UNITS)));
    expect(chain.simulations[0]!.trade.amount).toBe(5n * USDC_UNITS);
    expect(chain.simulations[0]!.overrides[0]!.balance).toBe(5n * 10n ** 18n);
  });

  it("never trades against an EURC pool: only USDC can be put at S", async () => {
    const chain = fakeChain({ simulation: roundTrip(TEN, TEN) });
    const eurOnly: Pool = { address: EURC_POOL, version: "v2", quote: "EURC", depth: 90_000n * USDC_UNITS, liquid: true };
    const f = await checkTrade(input(chain), scanOf(eurOnly));
    expect(chain.simulations).toHaveLength(0);
    expect(f).toMatchObject({ id: "trade", status: "unknown" });
    expect(f.detail).toMatch(/No USDC pool/);
  });

  it("tests with at least 0.01 USDC, however thin the pool looks: a v4 launch pool has next to no USDC in range", async () => {
    const chain = fakeChain({ simulation: roundTrip(10_000n, 9_940n) });
    await checkTrade(input(chain), scanOf(v4Pool(0n, USDC, 10000, 200)));
    expect(chain.simulations[0]!.trade.amount).toBe(10_000n);
  });

  it("swaps a v3 or an Aerodrome pool through its own swap (kind 1)", async () => {
    for (const pool of [v3Pool(20_000n * USDC_UNITS, 500), aeroPool(20_000n * USDC_UNITS)]) {
      const chain = fakeChain({ simulation: roundTrip(TEN, 9_990_000n) });
      await checkTrade(input(chain), scanOf(pool));
      expect(chain.simulations[0]!.trade).toMatchObject({ kind: 1, pool: POOL, usdc: USDC, amount: TEN });
    }
  });

  it("swaps a v4 pool through the PoolManager (kind 2) with its key, paying native USDC in 18 decimals", async () => {
    const pool = v4Pool(20_000n * USDC_UNITS, NATIVE, 3000, 60);
    const chain = fakeChain({ simulation: roundTrip(10n * 10n ** 18n, 994n * 10n ** 16n) });
    await checkTrade(input(chain), scanOf(pool));
    const { trade, overrides } = chain.simulations[0]!;
    expect(trade).toMatchObject({ kind: 2, pool: UNISWAP_V4.poolManager, token: TOKEN, usdc: NATIVE, amount: 10n * 10n ** 18n });
    expect(trade.key).toMatchObject({ currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE });
    // One balance: 10 USDC native is the same 10 USDC the ERC-20 view shows.
    expect(overrides[0]!.balance).toBe(10n * 10n ** 18n);
  });

  it("pays a v4 pool against the USDC ERC-20 in its 6 decimals", async () => {
    const chain = fakeChain({ simulation: roundTrip(TEN, 9_940_000n) });
    await checkTrade(input(chain), scanOf(v4Pool(20_000n * USDC_UNITS, USDC, 3000, 60)));
    expect(chain.simulations[0]!.trade).toMatchObject({ kind: 2, usdc: USDC, amount: TEN });
  });
});

describe("trade simulation: what the round trip means", () => {
  const judge = async (simulation: FakeChain["simulation"], pool: Pool = v2Pool(50_000n * USDC_UNITS)) =>
    checkTrade(input(fakeChain({ simulation })), scanOf(pool));

  it("says a loss too small to show in tenths is under 0.1%", async () => {
    const f = await judge(roundTrip(TEN, 9_996_000n), aeroPool(50_000n * USDC_UNITS));
    expect(f.detail).toMatch(/under 0\.1% lost/);
  });

  it("passes a round trip that loses no more than the pool's fees plus 3%", async () => {
    // v2: two 0.3% fees, 0.5991%; with 3% on top, a loss up to 3.5991% passes.
    const f = await judge(roundTrip(TEN, 9_650_000n));
    expect(f).toMatchObject({ id: "trade", status: "pass", evidenceUrl: `https://explorer.test/address/${PAIR}` });
    expect(f.detail).toMatch(/3\.5%/);
  });

  it("warns on a round trip that loses more, and says how much", async () => {
    const f = await judge(roundTrip(TEN, 8_970_000n));
    expect(f).toMatchObject({ status: "warn" });
    expect(f.title).toMatch(/10\.3%/);
  });

  it("uses the v3 pool's own fee tier", async () => {
    // 1%: 1.99% for two fees, so 4.99% is the line.
    expect((await judge(roundTrip(TEN, 9_510_000n), v3Pool(50_000n * USDC_UNITS, 10000))).status).toBe("pass");
    expect((await judge(roundTrip(TEN, 9_490_000n), v3Pool(50_000n * USDC_UNITS, 10000))).status).toBe("warn");
  });

  it("allows 5% on a pool whose fee can change: a dynamic-fee or hooked v4 pool, or Aerodrome", async () => {
    for (const pool of [v4Pool(50_000n * USDC_UNITS, USDC, DYNAMIC_FEE, 60), v4Pool(50_000n * USDC_UNITS, USDC, 3000, 60, HOOK), aeroPool(50_000n * USDC_UNITS)]) {
      expect((await judge(roundTrip(TEN, 9_510_000n), pool)).status).toBe("pass");
      expect((await judge(roundTrip(TEN, 9_490_000n), pool)).status).toBe("warn");
    }
  });

  it("warns that everything is lost when the buy delivered no tokens", async () => {
    const f = await judge(roundTrip(TEN, 0n, 0n));
    expect(f.status).toBe("warn");
    expect(f.title).toMatch(/100%/);
  });

  it("fails a token whose buy went through and whose sell reverted", async () => {
    const f = await judge(withStatus(3));
    expect(f).toMatchObject({ id: "trade", status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(/reverted/);
  });

  it.each([
    ["the buy reverted", 1],
    ["the buy ran out of gas", 2],
    ["the sell ran out of gas", 4],
    ["a status the simulator never returns", 9],
  ])("is unknown when %s: none of it is evidence about selling", async (_, status) => {
    expect((await judge(withStatus(status))).status).toBe("unknown");
  });

  it("is unknown when nothing was spent: there is no round trip to measure", async () => {
    expect((await judge(roundTrip(0n, 0n))).status).toBe("unknown");
  });
});

describe("trade simulation: when it can't run", () => {
  it("is unknown without a DEX, without a pool scan, or without a USDC pool", async () => {
    const chain = fakeChain();
    expect((await checkTrade(input(chain, null), scanOf(v2Pool(50_000n * USDC_UNITS)))).status).toBe("unknown");
    expect((await checkTrade(input(chain), null)).status).toBe("unknown");
    expect((await checkTrade(input(chain), scanOf())).status).toBe("unknown");
    expect(chain.simulations).toHaveLength(0);
  });

  it.each([
    ["the node ran no code (it ignored the override)", { returns: "0x" } as const],
    ["the answer doesn't decode", { returns: "0x1234" } as const],
    ["the call reverted or ran out of its gas", { reverts: true } as const],
    ["the node refused the override", { fails: Object.assign(new Error("invalid params"), { code: -32602 }) }],
    ["the endpoint failed", { fails: new Error("ETIMEDOUT") }],
  ])("is unknown when %s", async (_, simulation) => {
    const f = await checkTrade(input(fakeChain({ simulation })), scanOf(v2Pool(50_000n * USDC_UNITS)));
    expect(f).toMatchObject({ id: "trade", status: "unknown" });
  });
});

describe("trade simulation in a report", () => {
  const run = (simulation: FakeChain["simulation"]) =>
    inspect({
      ...input(fakeChain({
        code: { [TOKEN]: PLAIN },
        reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: PAIR, [`${USDC}.balanceOf(${PAIR})`]: 50_000n * USDC_UNITS },
        simulation,
      }), { quoteTokens: [{ address: USDC, symbol: "USDC" }], v2Factory: V2 }),
      now: () => new Date("2026-10-02T00:00:00Z"),
    });

  it("is the tenth check, last in the report", async () => {
    const r = await run(roundTrip(TEN, 9_940_000n));
    expect(r.total).toBe(9);
    expect(r.findings.at(-1)).toMatchObject({ id: "trade", status: "pass" });
  });

  it("marks the report degraded only when the endpoint failed, never for the node's own answer", async () => {
    expect((await run({ reverts: true })).degraded).toBe(false);
    expect((await run({ returns: "0x" })).degraded).toBe(false);
    expect((await run({ fails: Object.assign(new Error("invalid params"), { code: -32602 }) })).degraded).toBe(false);
    expect((await run({ fails: new Error("ETIMEDOUT") })).degraded).toBe(true);
  });
});
