import { describe, expect, it, vi } from "vitest";
import { UNISWAP_V4, inspectChain, type DexConfig } from "@arcos/chain";
import { IMPL_SLOT, checkHolders, checkLiquidity, checkLpLock, checkTrade, checkVerified, findPools, type SourcifyAnswers } from "../checks";
import { chainInput } from "../chain-input";
import type { ContractInfo, ExplorerSource, Holder } from "../explorer";
import { inspect } from "../inspect";
import type { VerificationSource } from "../sourcify";
import type { Finding, InspectInput, Pool, PoolScan, Report } from "../types";
import { NATIVE, sqrtRatioAtTick, v4PoolId, v4PoolKey } from "../v4";
import { fakeChain, readKey, v2PairReads, type FakeChain, type FakeReader } from "./fixtures/chain-fake";
import { arcFields } from "./fixtures/arc";

// Phase 1 of Inspector on other chains, in the engine: quotes in their own decimals, quotes with no dollar rate yet (WETH,
// native ETH), Solidly's classic pools, the pool kinds a chain can't scan, Sourcify beside the explorer, an explorer left
// out on purpose, and code that isn't EVM bytecode. Each chain's facts come from its registry entry (Base's here), with a
// DEX config of fake factories on the fake chain (fixtures/chain-fake.ts), whose Uniswap v4 contracts are Arc's.

const TOKEN = "0x1111111111111111111111111111111111111111"; // sorts below every quote
const V2 = "0x5555555555555555555555555555555555555555";
const V3 = "0x6666666666666666666666666666666666666666";
const SLIPSTREAM = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
const CLASSIC = "0x5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d";
const PAIR = "0x4444444444444444444444444444444444444444";
const PAIR_2 = "0x4545454545454545454545454545454545454545";
const V3_POOL = "0x7777777777777777777777777777777777777777";
const CLASSIC_POOL = "0x8888888888888888888888888888888888888888";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const BASE = inspectChain("mainnet", "base")!;
const USDC = BASE.dex!.quoteTokens[0]!.address; // Base's USDC: the trade check's currency, at slot 9
const WETH = BASE.dex!.quoteTokens[1]!.address;
const USD = BASE.dex!.quoteTokens[0]!;
const ETHER = BASE.dex!.quoteTokens[1]!;
const PLAIN = "0x63a9059cbb00"; // PUSH4 transfer, STOP

/** Base's own quotes and names, over fake factories and the fake chain's Uniswap v4. */
const baseLike: DexConfig = {
  quoteTokens: [USD, ETHER],
  v2Factory: V2,
  v3Factory: V3,
  v3FeeTiers: [3000],
  v4: UNISWAP_V4,
  aero: { clFactory: SLIPSTREAM, positionManager: "0x5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f", tickSpacings: [100], name: "Aerodrome Slipstream" },
  solidly: { factory: CLASSIC, name: "Aerodrome classic" },
};

/** Every factory question of `dex` for `token` answered "no pool". */
const noPools = (dex: DexConfig, token: string = TOKEN): Record<string, unknown> =>
  Object.fromEntries(
    dex.quoteTokens.flatMap((q) => [
      ...(dex.v2Factory ? [[readKey(dex.v2Factory, "getPair", [token, q.address]), NATIVE]] : []),
      ...(dex.v3Factory ? (dex.v3FeeTiers ?? []).map((fee) => [readKey(dex.v3Factory!, "getPool", [token, q.address, fee]), NATIVE]) : []),
      ...(dex.aero ? dex.aero.tickSpacings.map((s) => [readKey(dex.aero!.clFactory, "getPool", [token, q.address, s]), NATIVE]) : []),
      ...(dex.solidly ? [false, true].map((stable) => [readKey(dex.solidly!.factory, "getPool", [token, q.address, stable]), NATIVE]) : []),
    ]),
  );

/** An inspection of `TOKEN` on Base, over `chain`. */
const onBase = (chain: FakeReader, over: Partial<InspectInput> = {}): InspectInput => ({
  ...chainInput(BASE),
  dex: baseLike,
  address: TOKEN,
  network: "mainnet",
  reader: chain,
  explorer: null,
  ...over,
});

const pair = (address: string, quote: string, quoteReserve: bigint, lp?: { supply: bigint; burned: bigint }) => ({
  [readKey(V2, "getPair", [TOKEN, quote])]: address,
  ...v2PairReads(address, quote, TOKEN, quoteReserve),
  ...(lp ? { [readKey(address, "totalSupply", [])]: lp.supply, [readKey(address, "balanceOf", [NATIVE])]: 0n, [readKey(address, "balanceOf", [DEAD])]: lp.burned } : {}),
});
const v3Pool = (quote: string, balance: bigint) => ({ [readKey(V3, "getPool", [TOKEN, quote, 3000])]: V3_POOL, [readKey(quote, "balanceOf", [V3_POOL])]: balance });
const classicPool = (quote: string, balance: bigint, stable = false) => ({
  [readKey(CLASSIC, "getPool", [TOKEN, quote, stable])]: CLASSIC_POOL,
  [readKey(quote, "balanceOf", [CLASSIC_POOL])]: balance,
});
const scanOf = async (reads: Record<string, unknown>, over: Partial<FakeChain> = {}) => {
  const chain = fakeChain({ reads: { ...noPools(baseLike), ...reads }, ...over });
  return { chain, input: onBase(chain), scan: await findPools(onBase(chain)) };
};
const USDC_UNITS = 1_000_000n;
const ONE_WETH = 10n ** 18n;

describe("pool discovery off Arc", () => {
  it("finds pools against a quote with no dollar rate, in its own decimals, and never calls them liquid or thin", async () => {
    const { scan } = await scanOf({ ...pair(PAIR, WETH, 5n * ONE_WETH), ...v3Pool(WETH, 2n * ONE_WETH) });
    expect(scan.pools).toEqual([
      { address: PAIR, version: "v2", quote: "WETH", depth: 5_000_000n, liquid: null, undecided: "unpriced", tradable: true, tokenReserve: 10n ** 24n },
      { address: V3_POOL, version: "v3", quote: "WETH", depth: 2_000_000n, liquid: null, undecided: "unpriced", fee: 3000 },
    ]);
  });

  it("asks a Solidly factory for the volatile and the stable pool of every quote in one multicall, and never trades its pools", async () => {
    const { chain, scan } = await scanOf(classicPool(USDC, 5_000n * USDC_UNITS));
    const asked = chain.batches.find((b) => b.calls[0]!.target === CLASSIC)!.calls;
    expect(asked.map((c) => [c.fn, ...c.args.map((a) => String(a).toLowerCase())])).toEqual(
      [USDC, WETH].flatMap((q) => [false, true].map((stable) => ["getPool", TOKEN, q.toLowerCase(), String(stable)])),
    );
    expect(scan.pools).toEqual([{ address: CLASSIC_POOL, version: "solidly", quote: "USDC", depth: 5_000n * USDC_UNITS, liquid: true, tradable: false }]);
  });

  it("names a Solidly factory that never answered by the chain's name for it", async () => {
    const { scan } = await scanOf({}, { silent: [CLASSIC] });
    expect(scan.silent).toEqual(["Aerodrome classic"]);
  });

  it("finds Uniswap v4 pools against native ETH and WETH, and quotes neither: 1,000 ETH says nothing about 1,000 USD", async () => {
    const native = v4PoolKey(TOKEN, NATIVE, 3000, 60);
    const wrapped = v4PoolKey(TOKEN, WETH, 500, 10);
    const pool = { sqrtPriceX96: sqrtRatioAtTick(0), tick: 0, liquidity: 10n ** 18n, quote: { amountIn: 1n } };
    const { chain, scan } = await scanOf({}, { v4: { [v4PoolId(native)]: pool, [v4PoolId(wrapped)]: pool } });
    expect(chain.quotes).toEqual([]);
    expect(scan.pools.map((p) => [p.version, p.quote, p.liquid, p.undecided])).toEqual([
      ["v4", "WETH", null, "unpriced"],
      ["v4", "ETH", null, "unpriced"],
    ]);
  });
});

describe("the liquidity finding off Arc", () => {
  const liquidity = async (reads: Record<string, unknown>, over: Partial<FakeChain> = {}) => {
    const { input, scan } = await scanOf(reads, over);
    return checkLiquidity(input, scan);
  };

  it("says pools were found but aren't priced yet when every pool is against WETH", async () => {
    expect(await liquidity({ ...pair(PAIR, WETH, 5n * ONE_WETH), ...v3Pool(WETH, 2n * ONE_WETH) })).toEqual({
      id: "liquidity",
      status: "unknown",
      title: "Couldn't price the pools found",
      detail: "Pools against WETH were found, but they aren't priced yet.",
      evidenceUrl: `https://base.blockscout.com/address/${PAIR}`,
      fixAppId: null,
    });
  });

  it("still passes on a liquid USDC pool beside pools it can't price", async () => {
    const f = await liquidity({ ...pair(PAIR, WETH, 5n * ONE_WETH), ...v3Pool(USDC, 5_000n * USDC_UNITS) });
    expect(f).toMatchObject({ status: "pass", title: "5,000 USDC of liquidity on Uniswap v3" });
  });

  it("passes on a liquid classic pool, named as the chain names it", async () => {
    expect(await liquidity(classicPool(USDC, 5_000n * USDC_UNITS))).toMatchObject({ status: "pass", title: "5,000 USDC of liquidity on Aerodrome classic" });
  });

  it("never says 'no pool' where the chain has pools it can't see: unknown, naming every kind read and every kind not", async () => {
    expect(await liquidity({})).toEqual({
      id: "liquidity",
      status: "unknown",
      title: "No pool found where Inspector looks",
      detail:
        "Looked at Uniswap v2, Uniswap v3, Uniswap v4, Aerodrome Slipstream and Aerodrome classic pools against USDC and WETH. On Base, Inspector doesn't yet read Uniswap v4 pools with a hook or an unusual fee, Slipstream pools from other factories and pools on other DEXes, so a pool there can't be ruled out.",
      evidenceUrl: null,
      fixAppId: null,
    });
  });

  it("never says 'thin' there either", async () => {
    expect(await liquidity(v3Pool(USDC, 300n * USDC_UNITS))).toMatchObject({
      status: "unknown",
      title: "Only thin pools found where Inspector looks",
      detail:
        "Deepest pool holds 300 USDC. On Base, Inspector doesn't yet read Uniswap v4 pools with a hook or an unusual fee, Slipstream pools from other factories and pools on other DEXes, so a deeper pool there can't be ruled out.",
    });
  });

  it("keeps 'no pool' and 'thin' a warning on a chain that reads every kind of pool there is", async () => {
    const everywhere = (reads: Record<string, unknown>) => {
      const chain = fakeChain({ reads: { ...noPools(baseLike), ...reads } });
      const input = onBase(chain, { unscanned: [] });
      return findPools(input).then((scan) => checkLiquidity(input, scan));
    };
    expect(await everywhere({})).toMatchObject({ status: "warn", title: "No Uniswap, Aerodrome Slipstream or Aerodrome classic pool found" });
    expect(await everywhere(v3Pool(USDC, 300n * USDC_UNITS))).toMatchObject({ status: "warn", title: "Thin liquidity" });
  });

  it("gives the reasons apart when a priced pool is undecided too", async () => {
    // A hooked pool reaches discovery only through a list of extra pools (Arc's index); given one, both reasons are said.
    const hooked = v4PoolKey(TOKEN, USDC, 3000, 60, "0x94f8be2402C0e2eb65F3218a7282A5301371E044");
    const chain = fakeChain({ reads: { ...noPools(baseLike), ...pair(PAIR, WETH, 5n * ONE_WETH) }, v4: { [v4PoolId(hooked)]: { sqrtPriceX96: sqrtRatioAtTick(0), tick: 0, liquidity: 10n ** 12n } } });
    const input = onBase(chain, { extraPools: [{ version: "v4", key: hooked }] });
    expect(checkLiquidity(input, await findPools(input))).toMatchObject({
      status: "unknown",
      title: "Couldn't verify the pools found",
      detail: "A Uniswap v4 pool has a hook, which can change what a swap pays, so a quote can't judge its liquidity. Pools against WETH were found, but they aren't priced yet.",
    });
  });
});

describe("holders off Arc", () => {
  it("counts a classic pool and a pool against WETH as pools, never as wallets", async () => {
    const { input, scan } = await scanOf({ ...classicPool(USDC, 5_000n * USDC_UNITS), ...pair(PAIR, WETH, 5n * ONE_WETH) });
    const wallet = (i: number) => `0x${(0xa0 + i).toString(16).repeat(20)}`;
    const holders: Holder[] = [
      { address: CLASSIC_POOL, isContract: true, name: null, value: 600n },
      { address: PAIR, isContract: true, name: null, value: 300n },
      ...Array.from({ length: 10 }, (_, i) => ({ address: wallet(i), isContract: false, name: null, value: 10n })),
    ];
    expect(scan.pools.map((p) => p.address)).toEqual([PAIR, CLASSIC_POOL]);
    expect(checkHolders(input, { holders, complete: true }, 1_000n, scan, null)).toMatchObject({ status: "pass", title: "Top 10 wallets hold 10%" });
  });
});

describe("lp-lock off Arc, where no lock contracts are vetted", () => {
  const lpLock = async (reads: Record<string, unknown>, over: Partial<FakeChain> = {}) => {
    const { input, scan } = await scanOf(reads, over);
    return checkLpLock(input, scan);
  };
  /** The same on a chain that reads every kind of pool there is: Base's entry with nothing unscanned. */
  const lpLockEverywhere = async (reads: Record<string, unknown>) => {
    const input = onBase(fakeChain({ reads: { ...noPools(baseLike), ...reads } }), { unscanned: [] });
    return checkLpLock(input, await findPools(input));
  };
  const BASE_UNSCANNED =
    "On Base, Inspector doesn't yet read Uniswap v4 pools with a hook or an unusual fee, Slipstream pools from other factories and pools on other DEXes, so a deeper pool there can't be ruled out.";

  it("never passes a burned v2 pair where the chain has pools it can't see: one of them may hold more", async () => {
    expect(await lpLock(pair(PAIR, WETH, 5n * ONE_WETH, { supply: 100n, burned: 100n }))).toEqual({
      id: "lp-lock",
      status: "unknown",
      title: "Couldn't check liquidity locks",
      detail: `100% of the v2 LP supply can't be withdrawn. ${BASE_UNSCANNED}`,
      evidenceUrl: `https://base.blockscout.com/token/${PAIR}?tab=holders`,
      fixAppId: null,
    });
  });

  it("passes a burned v2 pair against WETH on a chain that reads every kind of pool: a share of LP needs no price", async () => {
    expect(await lpLockEverywhere(pair(PAIR, WETH, 5n * ONE_WETH, { supply: 100n, burned: 100n }))).toMatchObject({
      status: "pass",
      title: "Liquidity is burned or locked",
      detail: "100% of the v2 LP supply can't be withdrawn.",
      evidenceUrl: `https://base.blockscout.com/token/${PAIR}?tab=holders`,
    });
  });

  it("can't pass a token on a tiny burned pair beside a market the scan can't see, on Ethereum, however deep the pair", async () => {
    // One Uniswap v2 USDC pair holding 50 USDC, its LP all at 0xdead; the token's real market is on another DEX or in a
    // hooked v4 pool, which Ethereum's scan doesn't read. Liquidity says a deeper pool can't be ruled out, and so does lp-lock.
    const ethereum = inspectChain("mainnet", "ethereum")!;
    const [ethUsdc, ethUsdt, ethWeth] = ethereum.dex!.quoteTokens;
    const dex: DexConfig = { quoteTokens: [ethUsdc!, ethUsdt!, ethWeth!], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000], v4: UNISWAP_V4 };
    const onEthereum = async (usdc: bigint) => {
      const chain = fakeChain({
        reads: {
          ...noPools(dex),
          [readKey(V2, "getPair", [TOKEN, ethUsdc!.address])]: PAIR,
          ...v2PairReads(PAIR, ethUsdc!.address, TOKEN, usdc),
          [readKey(PAIR, "totalSupply", [])]: 100n,
          [readKey(PAIR, "balanceOf", [NATIVE])]: 0n,
          [readKey(PAIR, "balanceOf", [DEAD])]: 100n,
        },
      });
      const input: InspectInput = { ...chainInput(ethereum), dex, address: TOKEN, network: "mainnet", reader: chain, explorer: null };
      const scan = await findPools(input);
      return { lpLock: await checkLpLock(input, scan), liquidity: checkLiquidity(input, scan) };
    };
    const unscanned = "On Ethereum, Inspector doesn't yet read Uniswap v4 pools with a hook or an unusual fee and pools on other DEXes, so a deeper pool there can't be ruled out.";
    const tiny = await onEthereum(50n * USDC_UNITS);
    expect(tiny.liquidity).toMatchObject({ status: "unknown", detail: `Deepest pool holds 50 USDC. ${unscanned}` });
    expect(tiny.lpLock).toEqual({
      id: "lp-lock",
      status: "unknown",
      title: "Couldn't check liquidity locks",
      detail: `100% of the v2 LP supply can't be withdrawn. ${unscanned}`,
      evidenceUrl: `https://eth.blockscout.com/token/${PAIR}?tab=holders`,
      fixAppId: null,
    });
    // A deep pair is no exception: a pool the scan can't see may be deeper still.
    const deep = await onEthereum(5_000_000n * USDC_UNITS);
    expect(deep.liquidity).toMatchObject({ status: "pass" });
    expect(deep.lpLock).toMatchObject({ status: "unknown", detail: `100% of the v2 LP supply can't be withdrawn. ${unscanned}` });
  });

  it("never fails LP that isn't burned: it may sit in a lock contract nobody vetted", async () => {
    expect(await lpLock(pair(PAIR, WETH, 5n * ONE_WETH, { supply: 100n, burned: 40n }))).toMatchObject({
      status: "unknown",
      detail: "60% of the v2 LP supply isn't burned or in a known lock contract, and the lock contracts on Base aren't recognized yet, so whether it can be withdrawn can't be told.",
    });
  });

  it("can't tell which of two pairs holds the most when one is against WETH, and says so before reading either", async () => {
    const { chain, input, scan } = await scanOf({ ...pair(PAIR, USDC, 5_000n * USDC_UNITS, { supply: 100n, burned: 100n }), ...pair(PAIR_2, WETH, ONE_WETH, { supply: 100n, burned: 0n }) });
    // Both pairs answer one factory, so the second one's reads stand in for both.
    expect(scan.pools.filter((p) => p.version === "v2")).toHaveLength(2);
    const asked = chain.asked.length;
    expect(await checkLpLock(input, scan)).toMatchObject({
      status: "unknown",
      detail: "This token has Uniswap v2 pairs against USDC and WETH, and WETH isn't priced yet, so which one holds the most can't be told.",
    });
    expect(chain.asked.length).toBe(asked);
  });

  it("can't rank a pool against WETH beside a burned USDC pair: it may be the deeper one", async () => {
    expect(await lpLock({ ...pair(PAIR, USDC, 5_000n * USDC_UNITS, { supply: 100n, burned: 100n }), ...v3Pool(WETH, ONE_WETH) })).toMatchObject({
      status: "unknown",
      detail: "A Uniswap v3 pool against WETH sits beside this Uniswap v2 pair against USDC, and WETH isn't priced yet, so which holds more can't be told.",
    });
  });

  it("ranks pools against the same unpriced quote by their depth, as it ranks dollars", async () => {
    const burned = pair(PAIR, WETH, 5n * ONE_WETH, { supply: 100n, burned: 100n });
    // The shallower v3 pool is no rival: on Base it is what Base doesn't read that keeps the pair from passing.
    expect(await lpLockEverywhere({ ...burned, ...v3Pool(WETH, ONE_WETH) })).toMatchObject({ status: "pass" });
    expect(await lpLock({ ...burned, ...v3Pool(WETH, ONE_WETH) })).toMatchObject({ status: "unknown", detail: `100% of the v2 LP supply can't be withdrawn. ${BASE_UNSCANNED}` });
    // A deeper one is said first, as the pool that may hold more.
    expect(await lpLock({ ...burned, ...v3Pool(WETH, 9n * ONE_WETH) })).toMatchObject({
      status: "unknown",
      detail: "The deepest pool is a Uniswap v3 position, which can't be read without an index yet.",
    });
  });

  it("says it doesn't read who holds a deeper classic pool's liquidity, as a plain ERC-20 it is, not a position", async () => {
    expect(await lpLock({ ...pair(PAIR, USDC, 2_000n * USDC_UNITS, { supply: 100n, burned: 100n }), ...classicPool(USDC, 10_000n * USDC_UNITS) })).toEqual({
      id: "lp-lock",
      status: "unknown",
      title: "Couldn't check liquidity locks",
      detail: "The deepest pool is an Aerodrome classic pool, and Inspector doesn't read who holds the liquidity in it yet.",
      evidenceUrl: null,
      fixAppId: null,
    });
  });

  it("counts a native ETH v4 pool as one that may hold more than a burned pair, whatever the pair holds", async () => {
    const native = v4PoolKey(TOKEN, NATIVE, 3000, 60);
    const f = await lpLock(pair(PAIR, WETH, 5n * ONE_WETH, { supply: 100n, burned: 100n }), {
      v4: { [v4PoolId(native)]: { sqrtPriceX96: sqrtRatioAtTick(0), tick: 0, liquidity: 10n ** 18n } },
    });
    expect(f).toMatchObject({ status: "unknown", detail: "A Uniswap v4 pool that may hold more than this v2 pair sits beside it, and positions in it can't be read without an index yet." });
  });

  it("says it doesn't read who holds the classic pools' liquidity, without promising an index", async () => {
    expect(await lpLock(classicPool(USDC, 5_000n * USDC_UNITS))).toMatchObject({
      status: "unknown",
      detail: "Only Aerodrome classic pools were found, and Inspector doesn't read who holds the liquidity in them yet.",
    });
  });
});

describe("the trade check off Arc", () => {
  /** Every round trip comes back as 10 USDC in and 9.9 out. */
  const fine = { result: { status: 0, spent: 10n * USDC_UNITS, paidOut: 5n * 10n ** 18n, bought: 5n * 10n ** 18n, sold: 5n * 10n ** 18n, received: 9_900_000n } };

  it("funds the round trip through USDC's balance slot, never trades a classic pool, and counts a liquid one against a pass", async () => {
    const { chain, input, scan } = await scanOf({ ...v3Pool(USDC, 50_000n * USDC_UNITS), ...classicPool(USDC, 50_000n * USDC_UNITS) }, { simulation: fine });
    const f = await checkTrade(input, scan);
    expect(chain.simulations.map((s) => s.trade.pool)).toEqual([V3_POOL]);
    expect(chain.simulations[0]!.overrides.at(-1)).toMatchObject({ address: USDC, stateDiff: [expect.objectContaining({ slot: expect.stringMatching(/^0x[0-9a-f]{64}$/) })] });
    expect(f).toMatchObject({ status: "warn", title: "Another liquid pool wasn't measured" });
    expect(f.detail).toContain("Aerodrome classic 0x8888…8888 (liquid) wasn't traded against.");
  });

  it("names a pool against WETH by its quote when it keeps a round trip from a pass", async () => {
    const { input, scan } = await scanOf({ ...v3Pool(USDC, 50_000n * USDC_UNITS), ...pair(PAIR, WETH, 5n * ONE_WETH) }, { simulation: fine });
    const f = await checkTrade(input, scan);
    expect(f).toMatchObject({ status: "warn", title: "A pool of undecided liquidity wasn't measured" });
    expect(f.detail).toContain("Uniswap v2 0x4444…4444 (WETH) (liquidity undecided) wasn't traded against.");
  });
});

describe("source verification with Sourcify beside the explorer", () => {
  const input = (over: Partial<InspectInput> = {}): InspectInput => onBase(fakeChain(), over);
  const record = (verified: boolean | null): ContractInfo => ({ verified, name: null, abi: null, proxyType: null, implementations: [] });
  const verify = (contract: ContractInfo | null, sourcify: SourcifyAnswers, logic: { at: `0x${string}` | null; info: ContractInfo | null } | null = null, over: Partial<InspectInput> = {}) =>
    checkVerified(input(over), contract, logic, null, sourcify);
  const IMPL = "0x2222222222222222222222222222222222222222";
  const CONTRACT_TAB = `https://base.blockscout.com/address/${TOKEN}?tab=contract`;
  const SOURCIFY_PAGE = `https://repo.sourcify.dev/8453/${TOKEN}`;

  it("passes on either source's word, linking where the source can be read", async () => {
    expect(verify(record(true), { own: null, logic: null })).toMatchObject({ status: "pass", title: "Source code is verified", evidenceUrl: CONTRACT_TAB });
    expect(verify(record(false), { own: true, logic: null })).toMatchObject({ status: "pass", evidenceUrl: SOURCIFY_PAGE });
    expect(verify(null, { own: true, logic: null })).toMatchObject({ status: "pass", evidenceUrl: SOURCIFY_PAGE });
  });

  it("never fails off Arc on both saying no: Etherscan, which isn't read, may have the source", async () => {
    expect(verify(record(false), { own: false, logic: null })).toEqual({
      id: "verified",
      status: "unknown",
      title: "Couldn't check source verification",
      detail: "Not verified on Blockscout or Sourcify. Etherscan wasn't checked, and many contracts are verified there only.",
      evidenceUrl: CONTRACT_TAB,
      fixAppId: null,
    });
  });

  it("fails on both saying no where the chain allows a fail", async () => {
    expect(verify(record(false), { own: false, logic: null }, null, { unverifiedFails: true })).toMatchObject({ status: "fail", title: "Source code isn't verified" });
  });

  it("never fails off Arc on the explorer's 'not verified' alone either, when Sourcify isn't asked", async () => {
    const alone = (contract: ContractInfo, logic: { at: `0x${string}`; info: ContractInfo } | null = null, over: Partial<InspectInput> = {}) =>
      checkVerified(input(over), contract, logic, null, null);
    const ETHERSCAN = "Etherscan wasn't checked, and many contracts are verified there only.";
    expect(alone(record(false))).toEqual({
      id: "verified",
      status: "unknown",
      title: "Couldn't check source verification",
      detail: `The explorer says this contract isn't verified. ${ETHERSCAN}`,
      evidenceUrl: CONTRACT_TAB,
      fixAppId: null,
    });
    expect(alone(record(true), { at: IMPL, info: record(false) })).toMatchObject({
      status: "unknown",
      detail: `The proxy's own source is verified, but the explorer says the implementation it runs (${IMPL}) isn't. ${ETHERSCAN}`,
      evidenceUrl: `https://base.blockscout.com/address/${IMPL}?tab=contract`,
    });
    // Where the chain allows a fail, as Arc does, the explorer's word is enough, as it always was.
    expect(alone(record(false), null, { unverifiedFails: true })).toMatchObject({ status: "fail", title: "Source code isn't verified" });
    expect(alone(record(true), { at: IMPL, info: record(false) }, { unverifiedFails: true })).toMatchObject({ status: "fail", title: "The code this proxy runs isn't verified" });
  });

  it("says what each source did when they can't decide", async () => {
    const detail = (contract: ContractInfo | null, own: boolean | null, over: Partial<InspectInput> = {}) => verify(contract, { own, logic: null }, null, over).detail;
    expect(detail(null, false)).toBe("The explorer didn't answer. Sourcify has no match for this contract.");
    expect(detail(null, null)).toBe("The explorer didn't answer. Sourcify didn't answer.");
    expect(detail(record(null), false)).toBe("The explorer has no record of this contract yet. Sourcify has no match for this contract.");
    expect(detail(record(false), null)).toBe("The explorer says this contract isn't verified. Sourcify didn't answer.");
    expect(detail(null, null, { explorerSkipped: "The explorer wasn't asked." })).toBe("The explorer wasn't asked. Sourcify didn't answer.");
  });

  it("needs the code a proxy runs verified too, by either source", async () => {
    const proxy = (impl: ContractInfo | null, logic: boolean | null) => verify(record(true), { own: null, logic }, { at: IMPL, info: impl });
    expect(proxy(record(null), true)).toMatchObject({ status: "pass", detail: `Both this proxy and the implementation it runs (${IMPL}) are verified.` });
    expect(proxy(record(false), false)).toMatchObject({
      status: "unknown",
      detail: `The proxy's own source is verified, but the implementation it runs (${IMPL}) isn't verified on Blockscout or Sourcify. Etherscan wasn't checked, and many contracts are verified there only.`,
      evidenceUrl: `https://base.blockscout.com/address/${IMPL}?tab=contract`,
    });
    expect(proxy(null, null).detail).toBe(`This proxy's own source is verified, but whether ${IMPL} — the implementation it runs — is verified couldn't be checked. The explorer didn't answer. Sourcify didn't answer.`);
    expect(verify(record(true), { own: null, logic: null }, { at: null, info: null })).toMatchObject({ status: "unknown" });
  });
});

describe("a whole inspection off Arc", () => {
  const holders: Holder[] = Array.from({ length: 10 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, "0")}`, isContract: false, name: null, value: 10n }));
  const explorer = (verified: boolean | null): ExplorerSource => ({
    contract: async () => ({ verified, name: null, abi: null, proxyType: null, implementations: [] }),
    token: async () => ({ name: "Token", symbol: "TKN", decimals: 18, totalSupply: "1000", holdersCount: 10 }),
    topHolders: async () => ({ holders, complete: true }),
    tokenBalances: async () => [],
  });
  const sourcify = (answer: boolean | Error): VerificationSource & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      verified: async (address) => {
        asked.push(address);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  };
  const run = (code: string, over: Partial<InspectInput> = {}): Promise<Report> =>
    inspect(onBase(fakeChain({ code: { [TOKEN]: code }, reads: { ...noPools(baseLike), [readKey(TOKEN, "totalSupply", [])]: 1000n } }), over));
  const find = (r: Report, id: Finding["id"]) => r.findings.find((f) => f.id === id)!;

  it("asks Sourcify about the token, and a match there passes an explorer's 'not verified'", async () => {
    const source = sourcify(true);
    const r = await run(PLAIN, { explorer: explorer(false), verifyFallback: source });
    expect(source.asked).toEqual([TOKEN]);
    expect(find(r, "verified")).toMatchObject({ status: "pass", evidenceUrl: `https://repo.sourcify.dev/8453/${TOKEN}` });
    expect(r).toMatchObject({ chain: "base", chainId: 8453, degraded: false });
  });

  it("never fails source verification when no second source is given", async () => {
    const r = await run(PLAIN, { explorer: explorer(false) });
    expect(find(r, "verified")).toMatchObject({
      status: "unknown",
      detail: "The explorer says this contract isn't verified. Etherscan wasn't checked, and many contracts are verified there only.",
    });
  });

  it("marks the report degraded when Sourcify couldn't answer, and the finding unknown", async () => {
    const r = await run(PLAIN, { explorer: explorer(false), verifyFallback: sourcify(new Error("down")) });
    expect(find(r, "verified")).toMatchObject({ status: "unknown", detail: "The explorer says this contract isn't verified. Sourcify didn't answer." });
    expect(r.degraded).toBe(true);
  });

  it("gives the reason the explorer wasn't asked, in the report and in the explorer's findings", async () => {
    const reason = "The explorer wasn't asked: this server's daily share of explorer reads is used up.";
    const r = await run(PLAIN, { explorerSkipped: reason, verifyFallback: sourcify(false) });
    expect(r).toMatchObject({ explorerReachable: false, explorerSkipped: reason, degraded: false });
    expect(find(r, "holders")).toMatchObject({ status: "unknown", detail: reason });
    expect(find(r, "verified")).toMatchObject({ status: "unknown", detail: `${reason} Sourcify has no match for this contract.` });
    // Without one, a report carries no such field at all.
    expect("explorerSkipped" in (await run(PLAIN))).toBe(false);
  });

  it("reads an EIP-7702 delegated account's logic as unreadable, never scanned, and still reads its market", async () => {
    const r = await run(`0xef0100${"ab".repeat(20)}`, { explorer: explorer(true), verifyFallback: sourcify(true) });
    for (const id of ["verified", "ownership", "privileges", "proxy", "prevrandao"] as const) expect(find(r, id).status, id).toBe("unknown");
    expect(find(r, "privileges").detail).toBe("This address is an EIP-7702 delegated account: it runs another contract's code, which its key can change at any time, so its logic can't be read.");
    expect(find(r, "proxy").detail).toBe("This address is an EIP-7702 delegated account: its key can point it at other code at any time, which this check can't follow.");
    expect(find(r, "holders")).toMatchObject({ status: "pass" });
    expect(find(r, "liquidity")).toMatchObject({ status: "unknown", title: "No pool found where Inspector looks" });
    expect(r.findings.map((f) => f.id)).toEqual(["verified", "ownership", "privileges", "proxy", "holders", "liquidity", "lp-lock", "prevrandao", "trade"]);
  });

  it("checks an Arbitrum Stylus program's source as its own, and its logic as unreadable", async () => {
    const r = await run("0xeff00000aabbccddeeff", { explorer: explorer(true), verifyFallback: sourcify(false) });
    expect(find(r, "verified")).toMatchObject({ status: "pass" });
    for (const id of ["ownership", "privileges", "proxy", "prevrandao"] as const) expect(find(r, id).status, id).toBe("unknown");
    expect(find(r, "prevrandao").detail).toBe("This is an Arbitrum Stylus program (WebAssembly), not EVM bytecode, so its logic can't be read.");
  });

  describe("logic behind a proxy or a clone that isn't EVM bytecode", () => {
    const ARBITRUM = inspectChain("mainnet", "arbitrum")!;
    const IMPL = "0x2222222222222222222222222222222222222222";
    // A Stylus program: its prefix, then WebAssembly, whose bytes include 0x44 (PREVRANDAO) and 0xf4 (DELEGATECALL) as data.
    const STYLUS = `0xeff00000${"0a1b2c44f4"}${"9d".repeat(8)}44`;
    const clone = (target: string) => `0x363d3d373d3d3d363d73${target.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    /** An inspection on Arbitrum One of TOKEN with `code`, the EIP-1967 implementation slot of each address in `impl`. */
    const onArbitrum = (code: Record<string, string>, impl: Record<string, string> = {}, source = sourcify(false)) => {
      const chain = fakeChain({ code, reads: { [readKey(TOKEN, "totalSupply", [])]: 1000n } });
      const reader: FakeReader = {
        ...chain,
        getStorageAt: async (at, slot) => (slot === IMPL_SLOT && impl[at.toLowerCase()] ? (`0x${"00".repeat(12)}${impl[at.toLowerCase()]!.slice(2)}` as `0x${string}`) : null),
      };
      return inspect({ ...chainInput(ARBITRUM), dex: null, address: TOKEN, network: "mainnet", reader, explorer: explorer(true), verifyFallback: source });
    };
    const STYLUS_LOGIC = "This contract runs an Arbitrum Stylus program (WebAssembly), not EVM bytecode, so its logic can't be read.";

    it("never scans a proxy's Stylus implementation as EVM, and checks the program's source as its own", async () => {
      const source = sourcify(false);
      const r = await onArbitrum({ [TOKEN]: PLAIN, [IMPL]: STYLUS }, { [TOKEN]: IMPL }, source);
      // Scanned as EVM, the 0x44 in the WebAssembly read "Uses PREVRANDAO, always 1 on Arbitrum".
      expect(find(r, "prevrandao")).toEqual({ id: "prevrandao", status: "unknown", title: "Couldn't read the contract's logic", detail: STYLUS_LOGIC, evidenceUrl: null, fixAppId: null });
      expect(find(r, "privileges")).toMatchObject({ status: "unknown", detail: STYLUS_LOGIC });
      expect(find(r, "ownership")).toMatchObject({ status: "unknown" });
      expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Upgradeable proxy" });
      expect(source.asked).toEqual([TOKEN, IMPL]);
      expect(find(r, "verified")).toMatchObject({ status: "pass", detail: `Both this proxy and the implementation it runs (${IMPL}) are verified.` });
    });

    it("never calls a clone of a Stylus program or of an EIP-7702 delegated account 'not upgradeable'", async () => {
      const stylus = await onArbitrum({ [TOKEN]: clone(IMPL), [IMPL]: STYLUS });
      expect(find(stylus, "proxy")).toMatchObject({
        status: "unknown",
        title: "Couldn't check if this clone is upgradeable",
        detail: `This is an EIP-1167 clone of ${IMPL}, an Arbitrum Stylus program (WebAssembly), whose code this check can't read, so whether it forwards its calls elsewhere can't be told.`,
      });
      expect(find(stylus, "prevrandao")).toMatchObject({ status: "unknown", detail: STYLUS_LOGIC });
      const delegated = await onArbitrum({ [TOKEN]: clone(IMPL), [IMPL]: `0xef0100${"44".repeat(20)}` });
      expect(find(delegated, "proxy")).toMatchObject({
        status: "unknown",
        detail: `This is an EIP-1167 clone of ${IMPL}, an EIP-7702 delegated account, whose key can point it at other code at any time.`,
      });
      for (const id of ["privileges", "prevrandao"] as const) {
        expect(find(delegated, id).detail, id).toBe("This contract runs the code of an EIP-7702 delegated account, whose key can point it at other code at any time, so its logic can't be read.");
      }
      // Whatever code the account points at runs, so no one contract's source is "the implementation it runs".
      expect(find(delegated, "verified")).toMatchObject({ status: "unknown", detail: expect.stringContaining("forwards its calls to code that couldn't be identified") });
    });
  });
});

describe("Arc, untouched by any of it", () => {
  it("asks no second source and never words a skipped explorer, with Arc's own registry entry", async () => {
    const chain = fakeChain({ code: { [TOKEN]: PLAIN } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await inspect({ ...arcFields("mainnet"), address: TOKEN, network: "mainnet", reader: chain, explorer: null, dex: null, knownLockers: [], explorerBase: "https://explorer.arc.io" });
      expect("explorerSkipped" in r).toBe(false);
      expect(r.findings.find((f) => f.id === "verified")!.detail).toBe("The explorer didn't answer.");
    } finally {
      errors.mockRestore();
    }
  });

  it("still passes a burned v2 pair on Arc, which reads every kind of pool it has", async () => {
    const chain = fakeChain({ reads: { ...noPools(baseLike), ...pair(PAIR, USDC, 5_000n * USDC_UNITS, { supply: 100n, burned: 100n }) } });
    const input = { ...arcFields("mainnet"), address: TOKEN, network: "mainnet", reader: chain, explorer: null, dex: baseLike, knownLockers: [], explorerBase: "https://explorer.arc.io" } as InspectInput;
    expect(await checkLpLock(input, await findPools(input))).toMatchObject({ status: "pass", title: "Liquidity is burned or locked", detail: "100% of the v2 LP supply can't be withdrawn." });
  });

  it("passes an unscanned-free registry entry, so 'no pool' and 'thin' stay what they were", () => {
    const scan: PoolScan = { pools: [{ address: V3_POOL, version: "v3", quote: "USDC", depth: 300n * USDC_UNITS, liquid: false, fee: 3000 } as Pool], factoriesAnswered: true, silent: [] };
    const input = { ...arcFields("mainnet"), address: TOKEN, network: "mainnet", reader: fakeChain(), explorer: null, dex: baseLike, knownLockers: [], explorerBase: "https://explorer.arc.io" } as InspectInput;
    expect(checkLiquidity(input, scan)).toMatchObject({ status: "warn", title: "Thin liquidity", detail: "Deepest pool holds 300 USDC." });
  });
});
