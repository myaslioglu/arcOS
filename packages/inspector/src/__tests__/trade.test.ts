import { describe, expect, it } from "vitest";
import { AERODROME, EURC as EURC_TOKEN, UNISWAP_V4, USDC, tradeSimulatorRuntime, type DexConfig } from "@arcos/chain";
import { checkTrade } from "../checks";
import { inspect } from "../inspect";
import { TRADE_GAS, isOrdinaryAddress, randomAddress, simulatorAddresses } from "../simulate";
import type { InspectInput, Pool, PoolScan } from "../types";
import { NATIVE, v4PoolId, v4PoolKey } from "../v4";
import { fakeChain, v2PairReads, type FakeChain, type FakeReader, type FakeSimulation, type SimResult } from "./fixtures/chain-fake";

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
const lower = (a: string) => a.toLowerCase();
const v2Pool = (depth: bigint, over: Partial<Pool> = {}): Pool => ({ address: PAIR, version: "v2", quote: "USDC", depth, liquid: depth >= 1_000n * USDC_UNITS, ...over });
const v3Pool = (depth: bigint, fee: number): Pool => ({ address: POOL, version: "v3", quote: "USDC", depth, liquid: true, fee });
const aeroPool = (depth: bigint): Pool => ({ address: POOL, version: "aero", quote: "USDC", depth, liquid: true });
const v4Pool = (depth: bigint, quote: `0x${string}`, fee: number, tickSpacing: number, hooks?: `0x${string}`): Pool => {
  const key = v4PoolKey(TOKEN, quote, fee, tickSpacing, hooks);
  return { address: UNISWAP_V4.poolManager, version: "v4", quote: "USDC", depth, liquid: hooks ? null : true, key, poolId: v4PoolId(key), ...(hooks ? { undecided: "hook" as const } : {}) };
};

/** A round trip of `spent` that came back as `received`, every token the pool paid out arriving and sold. */
const roundTrip = (spent: bigint, received: bigint, bought = 5n * 10n ** 18n): FakeSimulation => ({
  result: { status: 0, spent, paidOut: bought, bought, sold: bought, received },
});
const withStatus = (status: number, over: Partial<SimResult> = {}): FakeSimulation => ({
  result: { status, spent: 10n * USDC_UNITS, paidOut: 5n * 10n ** 18n, bought: 5n * 10n ** 18n, sold: 0n, received: 0n, ...over },
});
const TEN = 10n * USDC_UNITS;
/** The fake's gas price (20 gwei) times the call's gas: what S is funded with on top of the test amount, to prepay the gas. */
const PREPAID = TRADE_GAS * 20_000_000_000n;

describe("trade simulation: which pool, how much, and the call", () => {
  it("trades against the deepest USDC pool in one eth_call from S to S, with the simulator's code and the USDC at S", async () => {
    const chain = fakeChain({ simulation: roundTrip(TEN, 9_940_000n) });
    await checkTrade(input(chain), scanOf(v2Pool(50_000n * USDC_UNITS), v3Pool(20_000n * USDC_UNITS, 3000)));
    expect(chain.simulations).toHaveLength(1);
    const [sim] = chain.simulations;
    const S = sim!.call.from;
    const R = sim!.trade.router;
    expect(sim!.call).toMatchObject({ to: S, gas: TRADE_GAS });
    expect(lower(R)).not.toBe(lower(S));
    // S holds the test amount plus the gas the call prepays; R, the router, only the code.
    expect(sim!.overrides).toEqual([
      { address: S, code: tradeSimulatorRuntime, balance: TEN * 10n ** 12n + PREPAID },
      { address: R, code: tradeSimulatorRuntime },
    ]);
    expect(sim!.trade).toMatchObject({ kind: 0, pool: PAIR, token: TOKEN, usdc: USDC, amount: TEN });
  });

  it("sets the call's gas price to the network's, so tx.gasprice isn't the 0 of a bare eth_call", async () => {
    const chain = fakeChain({ simulation: roundTrip(TEN, 9_940_000n), gasPrice: 160_000_000_000n });
    await checkTrade(input(chain), scanOf(v2Pool(50_000n * USDC_UNITS)));
    const [sim] = chain.simulations;
    expect(sim!.call.gasPrice).toBe(160_000_000_000n);
    expect(sim!.overrides[0]!.balance).toBe(TEN * 10n ** 12n + TRADE_GAS * 160_000_000_000n);
  });

  it("is unknown, and simulates nothing, when the gas price can't be read", async () => {
    const chain = fakeChain({ simulation: roundTrip(TEN, 9_940_000n), gasPrice: new Error("ETIMEDOUT") });
    const f = await checkTrade(input(chain), scanOf(v2Pool(50_000n * USDC_UNITS)));
    expect(f).toMatchObject({ id: "trade", status: "unknown" });
    expect(chain.simulations).toHaveLength(0);
  });

  it("runs from a fresh random S, with a fresh router R, every time", async () => {
    const chain = fakeChain({ simulation: roundTrip(TEN, 9_940_000n) });
    await checkTrade(input(chain), scanOf(v2Pool(50_000n * USDC_UNITS)));
    await checkTrade(input(chain), scanOf(v2Pool(50_000n * USDC_UNITS)));
    const [a, b] = chain.simulations;
    expect(lower(a!.call.from)).not.toBe(lower(b!.call.from));
    expect(lower(a!.trade.router)).not.toBe(lower(b!.trade.router));
    for (const sim of [a!, b!]) {
      expect(isOrdinaryAddress(sim.call.from)).toBe(true);
      expect(isOrdinaryAddress(sim.trade.router as `0x${string}`)).toBe(true);
    }
  });

  it("tests with 10 USDC, or 0.1% of the pool's depth when that is less", async () => {
    const chain = fakeChain({ simulation: roundTrip(5n * USDC_UNITS, 4_970_000n) });
    await checkTrade(input(chain), scanOf(v2Pool(5_000n * USDC_UNITS)));
    expect(chain.simulations[0]!.trade.amount).toBe(5n * USDC_UNITS);
    expect(chain.simulations[0]!.overrides[0]!.balance).toBe(5n * 10n ** 18n + PREPAID);
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
    expect(overrides[0]!.balance).toBe(10n * 10n ** 18n + PREPAID);
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

  it("fails a token that delivered none of what the pool paid out for the buy", async () => {
    const f = await judge(withStatus(0, { paidOut: 5n * 10n ** 18n, bought: 0n, sold: 0n, received: 0n }));
    expect(f).toMatchObject({ id: "trade", status: "fail", title: "Buying delivers no tokens" });
    expect(f.detail).toMatch(/the pool paid out, but none of the tokens arrived/);
  });

  it("is unknown when the pool paid nothing out for the buy: that is the pool's doing, not the token's", async () => {
    const f = await judge(withStatus(0, { paidOut: 0n, bought: 0n, sold: 0n, received: 0n }));
    expect(f).toMatchObject({ id: "trade", status: "unknown" });
  });

  it("warns that everything is lost when the tokens bought sell back for nothing", async () => {
    const f = await judge(roundTrip(TEN, 0n));
    expect(f.status).toBe("warn");
    expect(f.title).toMatch(/100%/);
  });

  it("fails a token whose buy went through and whose sell reverted", async () => {
    const f = await judge(withStatus(3));
    expect(f).toMatchObject({ id: "trade", status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(/Selling straight back, in the same transaction and from a contract, reverted\./);
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

describe("trade simulation: a sell the pool itself can refuse", () => {
  const deepV3 = v3Pool(50_000n * USDC_UNITS, 3000);
  const shallowV2 = v2Pool(5_000n * USDC_UNITS);
  /** The first round trip (against `first`) reverts on selling; any other answers `second`. */
  const byPool = (first: string, second: FakeSimulation) => (trade: { pool: string }) =>
    lower(trade.pool) === lower(first) ? withStatus(3) : second;
  const run = async (simulation: FakeChain["simulation"], ...pools: Pool[]) => {
    const chain = fakeChain({ simulation });
    const f = await checkTrade(input(chain), scanOf(...pools));
    return { f, chain };
  };

  it("warns, naming both pools, when the sell reverted in a v3 pool and went through in the v2 pair", async () => {
    const { f, chain } = await run(byPool(POOL, roundTrip(5n * USDC_UNITS, 4_970_000n)), deepV3, shallowV2);
    expect(chain.simulations.map((s) => s.trade.pool)).toEqual([POOL, PAIR]);
    expect(lower(chain.simulations[0]!.call.from)).not.toBe(lower(chain.simulations[1]!.call.from));
    expect(f).toMatchObject({ id: "trade", status: "warn", title: "Can't be sold into its deepest pool" });
    expect(f.detail).toMatch(/^Selling into its deepest pool \(Uniswap v3 0x7777…7777\) reverted; selling into the Uniswap v2 pair \(0x4444…4444\) went through \(5 USDC came back as 4\.97\)\./);
    expect(f.detail).toMatch(/refuse a token that arrives short \(a transfer tax\)/);
  });

  it("fails, naming both pools, when the sell reverts in the v2 pair too", async () => {
    const { f, chain } = await run(withStatus(3), deepV3, shallowV2);
    expect(chain.simulations).toHaveLength(2);
    expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(/Uniswap v3 0x7777…7777.*the Uniswap v2 pair \(0x4444…4444\)/);
  });

  it("warns, without a pass, when the RPC didn't run or answer the second round trip", async () => {
    for (const second of [{ returns: "0x" } as const, { fails: new Error("ETIMEDOUT") }]) {
      const { f } = await run(byPool(POOL, second), deepV3, shallowV2);
      expect(f).toMatchObject({ status: "warn", title: "Can't be sold into its deepest pool" });
      expect(f.detail).toMatch(/couldn't be completed/);
    }
  });

  it("keeps the fail when the second buy delivered tokens the pool would give nothing back for: no sell was sent", async () => {
    const { f } = await run(byPool(POOL, withStatus(0, { sold: 0n, received: 0n })), deepV3, shallowV2);
    expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(/the pool would give nothing back for the tokens bought, so no sell was sent, which shows nothing either way/);
    expect(f.detail).not.toMatch(/bought nothing/);
  });

  it("keeps the fail when the second sell went through and nothing came back", async () => {
    const { f } = await run(byPool(POOL, withStatus(0, { sold: 5n * 10n ** 18n, received: 0n })), deepV3, shallowV2);
    expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(/Selling into the Uniswap v2 pair \(0x4444…4444\), tried instead, went through, but nothing came back for 10 USDC of tokens/);
  });

  it("keeps the fail when the second pool's buy reverted or the pool paid nothing out: that pool doesn't trade", async () => {
    for (const second of [withStatus(1), withStatus(0, { paidOut: 0n, bought: 0n, sold: 0n, received: 0n }), withStatus(0, { spent: 0n })]) {
      const { f, chain } = await run(byPool(POOL, second), deepV3, shallowV2);
      expect(chain.simulations).toHaveLength(2);
      expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
      expect(f.detail).toMatch(/Buying from the Uniswap v2 pair \(0x4444…4444\) to try selling there instead (reverted|got nothing), so it has no other pool that trades to sell into\./);
    }
  });

  it("keeps the fail when the second round trip ran out of gas, buying or selling: that is undecided, not a sell", async () => {
    for (const [status, leg] of [[2, "Buying"], [4, "Selling"]] as const) {
      const { f, chain } = await run(byPool(POOL, withStatus(status)), deepV3, shallowV2);
      expect(chain.simulations).toHaveLength(2);
      expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
      expect(f.detail).toContain(`${leg} in the Uniswap v2 pair (0x4444…4444), tried instead, used up all the gas the simulation gives it`);
    }
    const { f } = await run(byPool(POOL, { reverts: true }), deepV3, shallowV2);
    expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(/reverted or ran out of its gas as a whole/);
  });

  it("fails with the evidence when the second pool paid out for the buy and no tokens arrived", async () => {
    const { f } = await run(byPool(POOL, withStatus(0, { paidOut: 5n * 10n ** 18n, bought: 0n, sold: 0n, received: 0n })), deepV3, shallowV2);
    expect(f).toMatchObject({ status: "fail", title: "Buying delivers no tokens" });
    expect(f.detail).toMatch(/Uniswap v3 0x7777…7777.*the Uniswap v2 pair \(0x4444…4444\).*none of the tokens arrived/);
  });

  it("never retries in a pool that can't trade: an empty or thin v2 pair, or a v4 pool whose depth is under the test amount", async () => {
    // Anyone can create a pair for nothing; its buy reverting must not turn the v3 pool's sell revert into a warning.
    const empty = v2Pool(0n);
    const thin = v2Pool(900n * USDC_UNITS);
    const shallowV4 = v4Pool(5n * USDC_UNITS, USDC, 3000, 60);
    for (const other of [empty, thin, shallowV4]) {
      const { f, chain } = await run(byPool(POOL, withStatus(1)), deepV3, other);
      expect(chain.simulations.map((s) => s.trade.pool)).toEqual([POOL]);
      expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
    }
  });

  it("retries in the deepest hookless v4 pool when there is no v2 pair", async () => {
    const v4 = v4Pool(1_000n * USDC_UNITS, USDC, 3000, 60);
    const { f, chain } = await run(byPool(POOL, roundTrip(TEN, 9_940_000n)), deepV3, v4);
    expect(chain.simulations[1]!.trade).toMatchObject({ kind: 2, pool: UNISWAP_V4.poolManager });
    expect(f.status).toBe("warn");
    expect(f.detail).toMatch(/the hookless Uniswap v4 pool \(0x/);
  });

  it.each([
    ["a Uniswap v3 pool", v3Pool(50_000n * USDC_UNITS, 3000), /Uniswap v3 pools refuse a token that arrives short \(a transfer tax\)/],
    ["an Aerodrome pool", aeroPool(50_000n * USDC_UNITS), /Aerodrome pools refuse a token that arrives short \(a transfer tax\)/],
    ["a hooked v4 pool", v4Pool(50_000n * USDC_UNITS, USDC, 3000, 60, HOOK), /hook runs inside every swap/],
  ])("still fails when the only pool is %s, and says why such a pool can refuse a sell", async (_, pool, why) => {
    const { f, chain } = await run(withStatus(3), pool);
    expect(chain.simulations).toHaveLength(1);
    expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(why);
    expect(f.detail).toMatch(/no Uniswap v2 or hookless Uniswap v4 USDC pool that trades to try selling into instead/);
  });

  it("doesn't retry a sell that reverted in a v2 pair or a hookless v4 pool: only the token can have refused it", async () => {
    for (const pool of [v2Pool(50_000n * USDC_UNITS), v4Pool(50_000n * USDC_UNITS, USDC, 3000, 60)]) {
      const { f, chain } = await run(withStatus(3), pool, v2Pool(1_000n * USDC_UNITS, { address: "0x9999999999999999999999999999999999999999" }));
      expect(chain.simulations).toHaveLength(1);
      expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
    }
  });

  it("trades against a pool without a hook before a deeper one with", async () => {
    const { chain } = await run(roundTrip(TEN, 9_940_000n), v4Pool(90_000n * USDC_UNITS, USDC, 3000, 60, HOOK), shallowV2);
    expect(chain.simulations[0]!.trade.pool).toBe(PAIR);
  });
});

describe("trade simulation: a deepest pool that can't trade", () => {
  // Anyone can make a pool look deep: USDC sent to a v3 or Aerodrome pool with no liquidity raises its balance, and USDC
  // sent to a v2 pair and synced raises its reserve with no tokens beside it. Its buy then can't trade.
  const decoyV3 = v3Pool(90_000n * USDC_UNITS, 3000);
  const realV2 = v2Pool(5_000n * USDC_UNITS);
  const run = async (simulation: FakeChain["simulation"], ...pools: Pool[]) => {
    const chain = fakeChain({ simulation });
    return { f: await checkTrade(input(chain), scanOf(...pools)), chain };
  };
  const decoyFirst = (decoy: string, then: FakeSimulation) => (trade: { pool: string }) =>
    lower(trade.pool) === lower(decoy) ? withStatus(1, { spent: 0n, paidOut: 0n, bought: 0n }) : then;

  it("moves on from a donated v3 pool whose buy reverts to the next pool, and says so", async () => {
    const { f, chain } = await run(decoyFirst(POOL, roundTrip(5n * USDC_UNITS, 4_970_000n)), decoyV3, realV2);
    expect(chain.simulations.map((s) => s.trade.pool)).toEqual([POOL, PAIR]);
    expect(f).toMatchObject({ status: "pass", evidenceUrl: `https://explorer.test/address/${PAIR}` });
    expect(f.detail).toMatch(/Buying in the deeper pool Uniswap v3 0x7777…7777 couldn't trade \(it reverted or got nothing\), so this was measured on the next one\./);
  });

  it("keeps a honeypot's fail behind a donated pool: the next pool's sell reverts", async () => {
    const { f } = await run(decoyFirst(POOL, withStatus(3)), decoyV3, realV2);
    expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
  });

  it("moves on from a pool that took USDC and paid nothing out", async () => {
    const paidNothing = (trade: { pool: string }) =>
      lower(trade.pool) === lower(POOL) ? withStatus(0, { paidOut: 0n, bought: 0n, sold: 0n, received: 0n }) : roundTrip(5n * USDC_UNITS, 4_970_000n);
    const { f, chain } = await run(paidNothing, decoyV3, realV2);
    expect(chain.simulations).toHaveLength(2);
    expect(f.status).toBe("pass");
  });

  it("tries at most three pools, and is unknown when none of them can trade", async () => {
    const pools = [
      v3Pool(90_000n * USDC_UNITS, 3000),
      v2Pool(80_000n * USDC_UNITS),
      { ...v3Pool(70_000n * USDC_UNITS, 500), address: "0x9999999999999999999999999999999999999999" as const },
      { ...v2Pool(60_000n * USDC_UNITS), address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const },
    ];
    const { f, chain } = await run(withStatus(1), ...pools);
    expect(chain.simulations).toHaveLength(3);
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/couldn't trade either\.$/);
  });

  it("never retries a refused sell in a pool whose buy already couldn't trade", async () => {
    // The decoy v2 pair is the deepest and can't trade; the v3 pool after it refuses the sell; only the decoy is a v2 pair.
    const decoyV2 = v2Pool(90_000n * USDC_UNITS);
    const v3 = v3Pool(50_000n * USDC_UNITS, 3000);
    const sim = (trade: { pool: string }) => (lower(trade.pool) === lower(PAIR) ? withStatus(1) : withStatus(3));
    const { f, chain } = await run(sim, decoyV2, v3);
    expect(chain.simulations.map((s) => s.trade.pool)).toEqual([PAIR, POOL]);
    expect(f).toMatchObject({ status: "fail", title: "Can't be sold" });
    expect(f.detail).toMatch(/the deepest pool it could be bought from \(Uniswap v3 0x7777…7777\)/);
  });
});

describe("trade simulation: the simulator's addresses", () => {
  it("gives up, instead of looping forever, when the random source keeps giving unusable or equal bytes", () => {
    expect(() => randomAddress((b) => b.fill(0))).toThrow();
    expect(() => simulatorAddresses((b) => b.fill(0x11))).toThrow();
  });

  it("draws 20 random bytes for each address, and never a mostly-zero one (a precompile, a system or a low address)", () => {
    const draws = [new Uint8Array(20), new Uint8Array(20).fill(0x36, 0, 1), new Uint8Array(20).fill(0xab)];
    let i = 0;
    const address = randomAddress((b) => b.set(draws[i++]!));
    expect(lower(address)).toBe(`0x${"ab".repeat(20)}`);
    expect(i).toBe(3);
  });

  it("accepts an address with up to three zero bytes, and not one with four", () => {
    expect(isOrdinaryAddress(`0x000000${"ab".repeat(17)}`)).toBe(true);
    expect(isOrdinaryAddress(`0x00000000${"ab".repeat(16)}`)).toBe(false);
    expect(isOrdinaryAddress("0x3600000000000000000000000000000000000000")).toBe(false);
    expect(isOrdinaryAddress("0x0000000000000000000000000000000000000001")).toBe(false);
  });

  it("never gives S and R the same address", () => {
    const draws = [0x11, 0x11, 0x22];
    let i = 0;
    const { simulator, router } = simulatorAddresses((b) => b.fill(draws[i++]!));
    expect(lower(simulator)).toBe(`0x${"11".repeat(20)}`);
    expect(lower(router)).toBe(`0x${"22".repeat(20)}`);
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
        reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: PAIR, ...v2PairReads(PAIR, USDC, TOKEN, 50_000n * USDC_UNITS) },
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
