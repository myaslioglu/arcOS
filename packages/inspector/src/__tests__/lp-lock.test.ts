import { describe, expect, it, vi } from "vitest";
import { AERODROME, EURC, UNISWAP_V4, USDC, type DexConfig } from "@arcos/chain";
import { SHARE_SCALE, checkLpLock, findPools, tallyLiquidity, type TokenFacts } from "../checks";
import { inspect } from "../inspect";
import type { ChainLog, ExtraPool, Finding, InspectInput, V4PositionIndex, V4PositionKey } from "../types";
import { MAX_EXTRA_POOLS, NATIVE, sqrtRatioAtTick, v4PoolId, v4PoolKey } from "../v4";
import { HEAD_MARGIN, INITIALIZE_TOPIC, MODIFY_LIQUIDITY_TOPIC } from "../v4-positions";
import { fakeChain, readKey, v2PairReads, type FakeChain, type FakePool, type FakePosition } from "./fixtures/chain-fake";
import { arcFields } from "./fixtures/arc";

// The lp-lock check with a fresh position index and a Uniswap v4 pool involved: the quote currency in every pool, by who
// can withdraw it. Without an index, with a stale one, or with no v4 pool, the check is the one pools.test.ts and
// inspect.test.ts cover, unchanged; the last block here holds that line.

const TOKEN = "0x1111111111111111111111111111111111111111"; // sorts below USDC: the token is currency0, USDC currency1
const HIGH = "0x9999999999999999999999999999999999999999"; // sorts above USDC: the token is currency1, USDC currency0
const V2 = "0x5555555555555555555555555555555555555555";
const V3 = "0x6666666666666666666666666666666666666666";
const PAIR = "0x4444444444444444444444444444444444444444";
const V3_POOL = "0x7777777777777777777777777777777777777777";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const WALLET = "0x00000000000000000000000000000000000b0b01";
const WALLET_2 = "0x00000000000000000000000000000000000b0b02";
const CONTRACT = "0x0000000000000000000000000000000000c0de01";
const LOCKER = "0x00000000000000000000000000000000000010c4";
const SENDER = "0x0000000000000000000000000000000000a11ce0";
const USD = { address: USDC, symbol: "USDC" };
const EUR = { address: EURC.mainnet, symbol: "EURC" };
const PM = UNISWAP_V4.positionManager;
const Q96 = 1n << 96n;
const HEAD = 1_000n;
const L = 10n ** 12n;

const v4Only: DexConfig = { quoteTokens: [USD], v4: UNISWAP_V4 };
const everything: DexConfig = { quoteTokens: [USD, EUR], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000], v4: UNISWAP_V4, aero: AERODROME };
/** Every factory question of `dex` for the token answered "no pool": the zero address, which is what a factory says. */
const noPools = (dex: DexConfig, token: string = TOKEN): Record<string, unknown> =>
  Object.fromEntries(
    dex.quoteTokens.flatMap((q) => [
      ...(dex.v2Factory ? [[readKey(dex.v2Factory, "getPair", [token, q.address]), NATIVE]] : []),
      ...(dex.v3Factory ? (dex.v3FeeTiers ?? []).map((fee) => [readKey(dex.v3Factory!, "getPool", [token, q.address, fee]), NATIVE]) : []),
      ...(dex.aero ? dex.aero.tickSpacings.map((spacing) => [readKey(dex.aero!.clFactory, "getPool", [token, q.address, spacing]), NATIVE]) : []),
    ]),
  );
const hookWith = (flags: string): `0x${string}` => `0x${"1".repeat(36)}${flags}`;
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const topic = (address: string): `0x${string}` => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

const key = v4PoolKey(TOKEN, USDC, 500, 10);
const id = v4PoolId(key);
/** A PositionManager NFT position, over [-600, 600] unless told. */
const nft = (tokenId: number, liquidity: bigint, tickLower = -600, tickUpper = 600): FakePosition => ({ owner: PM, tickLower, tickUpper, salt: salt(tokenId), liquidity });
const keyOf = ({ owner, tickLower, tickUpper, salt: s }: FakePosition): V4PositionKey => ({ owner: owner as `0x${string}`, tickLower, tickUpper, salt: s as `0x${string}` });

type PoolSetup = { key: ReturnType<typeof v4PoolKey>; positions: FakePosition[]; sqrtPriceX96?: bigint; tick?: number; listed?: boolean };
/** A chain with these v4 pools, and the index listing every position of each, caught up. */
function world(pools: PoolSetup[], over: { chain?: FakeChain; dex?: DexConfig; index?: V4PositionIndex | null; input?: Partial<InspectInput>; token?: `0x${string}` } = {}) {
  const v4: Record<string, FakePool> = {};
  const indexed: V4PositionIndex = { cursor: Number(HEAD - HEAD_MARGIN), pools: {} };
  for (const p of pools) {
    const tick = p.tick ?? 0;
    v4[v4PoolId(p.key)] = {
      sqrtPriceX96: p.sqrtPriceX96 ?? Q96,
      tick,
      liquidity: p.positions.filter((x) => x.tickLower <= tick && tick < x.tickUpper).reduce((s, x) => s + x.liquidity, 0n),
      quote: { amountIn: 1n },
      positions: p.positions,
    };
    indexed.pools[v4PoolId(p.key)] = { positions: p.positions.map(keyOf), truncated: false };
  }
  const reader = fakeChain({ head: HEAD, v4, ...over.chain });
  const extraPools: ExtraPool[] = pools.filter((p) => p.listed).map((p) => ({ version: "v4", key: p.key }));
  const index = over.index === undefined ? indexed : over.index;
  const input: InspectInput = {
    ...arcFields("mainnet"),
    address: over.token ?? TOKEN, network: "mainnet", reader, explorer: null, dex: over.dex ?? v4Only, knownLockers: [], explorerBase: "https://explorer.test",
    ...(extraPools.length > 0 ? { extraPools } : {}),
    ...(index ? { v4Positions: index } : {}),
    ...over.input,
  };
  return { reader, input };
}
async function check(pools: PoolSetup[], over: Parameters<typeof world>[1] = {}): Promise<Finding> {
  const { input } = world(pools, over);
  return checkLpLock(input, await findPools(input));
}
/** One pool at price 1 holding `positions`. */
const lpLock = (positions: FakePosition[], over: Parameters<typeof world>[1] & { poolKey?: typeof key; listed?: boolean } = {}) =>
  check([{ key: over.poolKey ?? key, positions, listed: over.listed }], over);
const owners = (map: Record<number, string>): FakeChain => ({ nftOwners: map });

// --- The world most cases below are set in: the token at $0.001 (tick -345,420, a multiple of 60 and of 10), 18 decimals,
// a supply of one billion, USDC (6 decimals) as currency1. ---
const T0 = -345_420;
const MAIN = v4PoolKey(TOKEN, USDC, 3000, 60);
const SIDE = key; // T/USDC 0.05%: another standard tier, always probed
const FACTS: TokenFacts = { supply: 10n ** 27n, decimals: 18 };
/** Liquidity for a quote-only range [lo, hi] (below the price) holding `usdc` whole USDC. */
const quoteOnlyL = (lo: number, hi: number, usdc: bigint) => (usdc * 10n ** 6n * Q96) / (sqrtRatioAtTick(hi) - sqrtRatioAtTick(lo));
/** Liquidity for a token-only range [lo, hi] (above the price) holding `tokens` whole 18-decimal tokens. */
const tokenOnlyL = (lo: number, hi: number, tokens: bigint) => {
  const [a, b] = [sqrtRatioAtTick(lo), sqrtRatioAtTick(hi)];
  return (tokens * 10n ** 18n * a * b) / (Q96 * (b - a));
};
/** A two-sided range from half the price to twice it ([T0 - 6,960, T0 + 6,960]) holding `usdc` now: buyers pay 1.42 times that into it on the way up. */
const [LO, HI] = [T0 - 6_960, T0 + 6_960];
const twoSided = (id: number, usdc: bigint) => nft(id, (usdc * 10n ** 6n * Q96) / (sqrtRatioAtTick(T0) - sqrtRatioAtTick(LO)), LO, HI);
/** A single-sided launch range from the price up to twice it, holding `tokens`: every buyer pays into it. */
const launch = (id: number, tokens = 100_000_000n) => nft(id, tokenOnlyL(T0, HI, tokens), T0, HI);
const main = (positions: FakePosition[], poolKey = MAIN): PoolSetup => ({ key: poolKey, tick: T0, sqrtPriceX96: sqrtRatioAtTick(T0), positions, listed: BigInt(poolKey.hooks) !== 0n });
/** The verdict for these pools and NFT owners, with the token's supply and decimals known. */
const verdict = async (pools: PoolSetup[], nftOwners: Record<number, string>, over: Parameters<typeof world>[1] = {}, facts = FACTS) => {
  const { input } = world(pools, { ...over, chain: { nftOwners, ...over.chain } });
  return checkLpLock(input, await findPools(input), facts);
};
const ORDER = "Counted in the order buyers' money would arrive, cheapest tokens first across this token's pools, up to twice the price at which 1,000 USDC has been paid.";

describe("lp-lock over a Uniswap v4 pool's positions", () => {
  it("fails when a wallet holds the liquidity: where buyers' money goes, what the wallet holds now, a Vault fix and the NFT's page", async () => {
    const f = await verdict([main([twoSided(7, 2_000n)])], { 7: WALLET });
    expect(f).toEqual({
      id: "lp-lock",
      status: "fail",
      title: "Liquidity isn't locked",
      detail: `Of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw and 0% into burned or locked ones. Of the 1,999 USDC in its pools now, wallets' positions hold 1,999 and burned or locked ones 0. ${ORDER}`,
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: "vault",
    });
  });

  it("passes when the NFT sits at a burn address", async () => {
    const f = await verdict([main([twoSided(7, 2_000n)])], { 7: DEAD });
    expect(f).toEqual({
      id: "lp-lock",
      status: "pass",
      title: "Liquidity is burned or locked",
      detail: `Of the first 1,000 USDC buyers would pay for this token, 100% goes into burned or locked positions (burned: 100%, locked: 0%). Of the 1,999 USDC in its pools now, burned or locked positions hold 1,999. ${ORDER}`,
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: null,
    });
  });

  it("passes when a known locker holds it, and says which share is locked", async () => {
    const f = await verdict([main([twoSided(1, 3_000n), twoSided(2, 1_000n)])], { 1: LOCKER, 2: NATIVE }, { input: { knownLockers: [LOCKER] } });
    expect(f).toMatchObject({ status: "pass", detail: expect.stringContaining("100% goes into burned or locked positions (burned: 25%, locked: 75%)") as string });
  });

  it("is unknown, never a fail, when a contract holds it: the contract may be a locker", async () => {
    const f = await verdict([main([twoSided(7, 2_000n)])], { 7: CONTRACT }, { chain: { code: { [CONTRACT]: "0x6080" } } });
    expect(f).toMatchObject({
      status: "unknown",
      title: "Couldn't check liquidity locks",
      detail: `100% of the first 1,000 USDC buyers would pay goes to contracts whose lock terms can't be read. 100% of the 1,999 USDC in its pools now sits with contracts whose lock terms can't be read. Burned or locked needs 95% throughout to pass. ${ORDER}`,
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: null,
    });
  });

  it("classifies a position held straight in the PoolManager by its sender: a contract, linked by its address", async () => {
    const own: FakePosition = { ...twoSided(0, 2_000n), owner: SENDER };
    const f = await verdict([main([own])], {}, { chain: { code: { [SENDER]: "0x6080" } } });
    expect(f).toMatchObject({ status: "unknown", evidenceUrl: `https://explorer.test/address/${SENDER}` });
    expect(f.detail).toMatch(/goes to contracts whose lock terms can't be read/);
  });

  it("counts an EIP-7702 wallet as a wallet", async () => {
    const f = await verdict([main([twoSided(7, 2_000n)])], { 7: WALLET }, { chain: { code: { [WALLET]: `0xef0100${"ab".repeat(20)}` } } });
    expect(f.status).toBe("fail");
  });

  describe("the lines: fail from 50% to wallets, pass from 95% safe, warn above 5% to wallets", () => {
    // Every position over the same range, so every prefix and the bids give the same shares.
    const split = (burned: bigint, wallet: bigint, contract = 0n) =>
      verdict([main([twoSided(1, burned * 100n), twoSided(2, wallet * 100n), ...(contract > 0n ? [twoSided(3, contract * 100n)] : [])])], { 1: DEAD, 2: WALLET, 3: CONTRACT }, { chain: { code: { [CONTRACT]: "0x6080" } } });
    it("passes at exactly 95% burned with 5% in a wallet", async () => {
      expect(await split(95n, 5n)).toMatchObject({ status: "pass", fixAppId: null, detail: expect.stringContaining("95% goes into burned or locked positions") as string });
    });
    it("warns just past 5% to wallets, with the Vault fix and what they hold", async () => {
      expect(await split(94n, 6n)).toMatchObject({
        status: "warn",
        title: "Some liquidity isn't locked",
        fixAppId: "vault",
        detail: `Of the first 1,000 USDC buyers would pay for this token, 6% goes into positions wallets can withdraw and 94% into burned or locked ones. Of the 9,999 USDC in its pools now, wallets' positions hold 599 and burned or locked ones 9,399. ${ORDER}`,
        evidenceUrl: `https://explorer.test/token/${PM}/instance/2`,
      });
    });
    it("warns just under half to wallets, and fails at exactly half", async () => {
      expect((await split(51n, 49n)).status).toBe("warn");
      expect(await split(50n, 50n)).toMatchObject({ status: "fail", title: "Liquidity isn't locked", fixAppId: "vault" });
      expect((await split(10n, 50n, 40n)).status).toBe("fail");
    });
    it("is unknown when too little is safe to pass and too little goes to wallets to warn", async () => {
      const f = await split(90n, 5n, 5n);
      expect(f).toMatchObject({ status: "unknown", fixAppId: null });
      expect(f.detail).toMatch(/^5% of the first 1,000 USDC buyers would pay goes to contracts whose lock terms can't be read\./);
    });
    it("warns on a third party's 10% whoever holds the rest", async () => {
      expect((await split(0n, 10n, 90n)).status).toBe("warn");
    });
  });

  it("links the largest position that isn't safe", async () => {
    const f = await verdict([main([twoSided(1, 200n), twoSided(2, 500n), twoSided(3, 9_000n)])], { 1: WALLET, 2: WALLET_2, 3: DEAD });
    expect(f).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/2` });
  });

  it("drops positions that hold nothing, and can't judge pools with nothing in them", async () => {
    expect(await verdict([main([nft(1, 0n, LO, HI), twoSided(2, 2_000n)])], { 2: DEAD })).toMatchObject({ status: "pass" });
    expect(await verdict([main([nft(1, 0n, LO, HI)])], { 1: WALLET })).toMatchObject({
      status: "unknown",
      detail: "This token's pools hold no USDC and sell no tokens now, so there is no liquidity to judge.",
      fixAppId: null,
    });
  });

  it("doesn't pass on burned liquidity that would take under 1,000 USDC from buyers: too little to call locked", async () => {
    // 100 USDC in the range now; buyers pay 142 into it before it runs out.
    const f = await verdict([main([twoSided(7, 100n)])], { 7: DEAD });
    expect(f).toMatchObject({ status: "unknown", fixAppId: null });
    expect(f.detail).toBe(`Its pools would take under 1,000 USDC from buyers: too little to call locked liquidity. Burned or locked needs 95% throughout to pass. ${ORDER}`);
    // 710 now, 1,008 on the way up: enough.
    expect((await verdict([main([twoSided(7, 710n)])], { 7: DEAD })).status).toBe("pass");
    // The same thin liquidity in a wallet is still a fail: the whole path is the wallet's.
    expect((await verdict([main([twoSided(7, 100n)])], { 7: WALLET })).status).toBe("fail");
  });

  describe("a hook that runs when liquidity is removed", () => {
    const hooked = (flags: string) => v4PoolKey(TOKEN, USDC, 10_000, 60, hookWith(flags));
    it.each([["BEFORE_REMOVE_LIQUIDITY", "0200"], ["AFTER_REMOVE_LIQUIDITY", "0100"], ["AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA", "0001"]])("makes a wallet's position unknown: %s", async (_name, flags) => {
      const f = await verdict([main([twoSided(7, 2_000n)], hooked(flags))], { 7: WALLET });
      expect(f).toMatchObject({ status: "unknown", fixAppId: null });
      expect(f.detail).toMatch(/^100% of the first 1,000 USDC buyers would pay goes to wallets' positions in a pool whose hook runs when liquidity is removed, so it can block or tax a withdrawal\./);
    });
    it("leaves a burned position burned", async () => {
      expect((await verdict([main([twoSided(7, 2_000n)], hooked("0200"))], { 7: DEAD })).status).toBe("pass");
    });
    it("changes nothing when the hook has no remove-liquidity permission", async () => {
      expect((await verdict([main([twoSided(7, 2_000n)], hooked("2000"))], { 7: WALLET })).status).toBe("fail");
    });
  });

  describe("a hook that runs in swaps", () => {
    // The launchpad kind: BEFORE_SWAP, AFTER_SWAP and both of their RETURNS_DELTA flags (0x20cc on Arc mainnet).
    const swapHooked = v4PoolKey(TOKEN, USDC, 0, 200, hookWith("20cc"));
    it("can't carry a pass on a burned position: whether buyers' money reaches it is the hook's to decide", async () => {
      const f = await verdict([main([launch(7)], swapHooked)], { 7: DEAD });
      expect(f).toMatchObject({ status: "unknown", fixAppId: null });
      expect(f.detail).toMatch(/^100% of the first 1,000 USDC buyers would pay goes to burned or locked positions in a pool whose hook runs in every swap, so whether buyers' money reaches them is the hook's to decide\./);
      for (const flags of ["0080", "0040", "0008", "0004"]) {
        expect((await verdict([main([launch(7)], v4PoolKey(TOKEN, USDC, 100, 60, hookWith(flags)))], { 7: DEAD })).status, flags).toBe("unknown");
      }
    });
    it("still fails a wallet's position there: a wallet can withdraw whatever the hook does", async () => {
      expect(await verdict([main([launch(7)], swapHooked)], { 7: WALLET })).toMatchObject({ status: "fail", fixAppId: "vault" });
      expect((await verdict([main([twoSided(7, 2_000n)], swapHooked)], { 7: WALLET })).status).toBe("fail");
    });
    it("is as any other pool when the hook has no swap flag", async () => {
      // Initialize and add-liquidity flags only.
      expect((await verdict([main([launch(7)], v4PoolKey(TOKEN, USDC, 100, 60, hookWith("3c00")))], { 7: DEAD })).status).toBe("pass");
    });
  });

  describe("holders, many of them", () => {
    // G: a wallet-held launch range split into 100 equal NFTs in 100 wallets, next to a burned range holding 2,000 USDC.
    const split = () => {
      const positions = [twoSided(2, 2_000n)];
      const nftOwners: Record<number, string> = { 2: DEAD };
      for (let i = 0; i < 100; i++) {
        positions.push(nft(100 + i, tokenOnlyL(T0, HI, 1_000_000n), T0, HI));
        nftOwners[100 + i] = `0x${(0xb0b100 + i).toString(16).padStart(40, "0")}`;
      }
      return { positions, nftOwners };
    };
    it("fails a launch range split over 100 wallets exactly as it does in one wallet: every holder is classified, in one call", async () => {
      const one = await verdict([main([twoSided(2, 2_000n), launch(100)])], { 2: DEAD, 100: WALLET });
      const { positions, nftOwners } = split();
      const { input, reader } = world([main(positions)], { chain: { nftOwners } });
      const many = await checkLpLock(input, await findPools(input), FACTS);
      expect(one.status).toBe("fail");
      expect(many).toMatchObject({ status: "fail", detail: one.detail });
      expect(reader.codeReads).toEqual([100]);
    });
    it("never calls it a mere warning when holders it couldn't classify could make it a fail", async () => {
      // The node won't run the batched read, so only the 40 largest are read: 60 of the 100 wallets stay unclassified.
      const { positions, nftOwners } = split();
      const f = await verdict([main(positions)], nftOwners, { chain: { codeReaderFails: new Error("no state override") } });
      expect(f).toMatchObject({ status: "unknown", fixAppId: null });
      expect(f.detail).toMatch(/^60 holders of this token's liquidity weren't classified, more than this check reads\. Wallets take 3[0-9](\.\d)?% and those holders 5[0-9](\.\d)?%: together they could hold half or more\./);
    });
    it("names holders left unclassified as that, when what they hold is small", async () => {
      const positions = [twoSided(2, 9_300n), ...Array.from({ length: 70 }, (_, i) => twoSided(100 + i, 10n))];
      const nftOwners = Object.fromEntries([[2, DEAD], ...positions.slice(1).map((_, i) => [100 + i, `0x${(0xb0b100 + i).toString(16).padStart(40, "0")}`])]) as Record<number, string>;
      const f = await verdict([main(positions)], nftOwners, { chain: { codeReaderFails: new Error("no state override") } });
      // 40 wallets read (4%), 30 unclassified (3%): neither a warning's worth of wallets nor enough safe to pass.
      expect(f.status).toBe("unknown");
      expect(f.detail).toMatch(/3% of the first 1,000 USDC buyers would pay goes to holders too many to classify\./);
    });
  });
});

describe("buyers' money in price order: the review's cases", () => {
  it("A. burned bids in a side pool priced 10x lower don't set the price: the wallet's launch range is first in line", async () => {
    const dTick = T0 - 23_030;
    const bids = nft(2, quoteOnlyL(dTick - 10_000, dTick - 10, 1_500n), dTick - 10_000, dTick - 10);
    const f = await verdict([main([launch(1)]), { key: SIDE, tick: dTick, sqrtPriceX96: sqrtRatioAtTick(dTick), positions: [bids] }], { 1: WALLET, 2: DEAD });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toMatch(/^Of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw/);
    // The same bids at the main pool's price: no different.
    const same = nft(2, quoteOnlyL(T0 - 10_000, T0 - 10, 1_500n), T0 - 10_000, T0 - 10);
    expect((await verdict([main([launch(1)]), { key: SIDE, tick: T0, sqrtPriceX96: sqrtRatioAtTick(T0), positions: [same] }], { 1: WALLET, 2: DEAD })).status).toBe("fail");
  });

  it("B. a burned range from half the price to twice it, and a wallet's range from just past that", async () => {
    // The window runs to twice the price at which 1,000 USDC has been paid, which is 1.3 times today's: 2.6x. A wall
    // starting at 2x is inside it, and takes most of what buyers pay there: a fail.
    const above = nft(3, tokenOnlyL(HI, HI + 39_120, 500_000_000n), HI, HI + 39_120);
    const inside = await verdict([main([twoSided(2, 2_000n), above])], { 2: DEAD, 3: WALLET });
    expect(inside).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/3` });
    // Starting at 4x it is beyond the window: a warning, with the tokens counted and no price put on them.
    const far = nft(3, tokenOnlyL(T0 + 13_860, T0 + 39_120, 500_000_000n), T0 + 13_860, T0 + 39_120);
    const f = await verdict([main([twoSided(2, 2_000n), far])], { 2: DEAD, 3: WALLET });
    expect(f).toMatchObject({ status: "warn", title: "Some liquidity isn't locked", fixAppId: "vault", evidenceUrl: `https://explorer.test/token/${PM}/instance/3` });
    expect(f.detail).toBe(
      `Of the first 1,000 USDC buyers would pay for this token, 0% goes into positions wallets can withdraw and 100% into burned or locked ones. Of the 1,999 USDC in its pools now, wallets' positions hold 0 and burned or locked ones 1,999. Wallets also hold 499.9M tokens in positions above twice that price, which buyers would pay into if the price rises that far. ${ORDER}`,
    );
  });

  it("C and D. a stranger's USDC parked as bids below a burned launch: material only from 1,000 USDC in the pools", async () => {
    const parked = (usdc: bigint) => nft(4, quoteOnlyL(T0 - 20_000, T0 - 7_020, usdc), T0 - 20_000, T0 - 7_020);
    // 2,000 beside 2,000 burned: half the USDC in the pools is a wallet's.
    expect((await verdict([main([twoSided(2, 2_000n), parked(2_000n)])], { 2: DEAD, 4: WALLET_2 })).status).toBe("fail");
    // 120 beside 2,000: 5.7%.
    expect((await verdict([main([twoSided(2, 2_000n), parked(120n)])], { 2: DEAD, 4: WALLET_2 })).status).toBe("warn");
    expect((await verdict([main([twoSided(2, 2_000n), parked(100n)])], { 2: DEAD, 4: WALLET_2 })).status).toBe("pass");
  });

  it("a stranger's dollar of bids can't flip a burned launch that holds no USDC yet, and neither can 49; 50 makes it unknown, never a fail", async () => {
    const parked = (usdc: bigint) => nft(4, quoteOnlyL(T0 - 20_000, T0 - 7_020, usdc), T0 - 20_000, T0 - 7_020);
    expect((await verdict([main([launch(1)])], { 1: DEAD })).status).toBe("pass");
    expect((await verdict([main([launch(1), parked(1n)])], { 1: DEAD, 4: WALLET_2 })).status).toBe("pass");
    expect((await verdict([main([launch(1), parked(49n)])], { 1: DEAD, 4: WALLET_2 })).status).toBe("pass");
    const f = await verdict([main([launch(1), parked(60n)])], { 1: DEAD, 4: WALLET_2 });
    expect(f).toMatchObject({ status: "unknown", fixAppId: null });
    expect(f.detail).toMatch(/^(59|60) of the (59|60) USDC in its pools now is outside burned or locked positions\./);
    expect((await verdict([main([launch(1), parked(999n)])], { 1: DEAD, 4: WALLET_2 })).status).toBe("unknown");
  });

  it("up to 999 USDC of buyers' money in a wallet's bought-through range doesn't sit under a pass", async () => {
    // The wallet's range, from below the price up to it, has been bought through: it holds 999 USDC and no tokens. Above the
    // price everything for sale is burned.
    const bought = nft(1, quoteOnlyL(T0 - 960, T0, 999n), T0 - 960, T0);
    const f = await verdict([main([bought, launch(2)])], { 1: WALLET, 2: DEAD });
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/99[89] of the 99[89] USDC in its pools now is outside burned or locked positions\./);
    // From 1,000 it is material, and a fail.
    expect((await verdict([main([nft(1, quoteOnlyL(T0 - 960, T0, 1_001n), T0 - 960, T0), launch(2)])], { 1: WALLET, 2: DEAD })).status).toBe("fail");
  });

  it("F. a wallet's token range just above the price in a native-USDC pool, beside a burned USDC pool at the same price", async () => {
    // In the native pool the token is currency1 (18-decimal native USDC is currency0): the same $0.001 is tick 69,060 the
    // other way up, and "just above the token's price" is the ticks just below.
    const N0 = 69_060;
    const [a, b] = [sqrtRatioAtTick(N0 - 6_960), sqrtRatioAtTick(N0)];
    const wall = nft(5, (50_000_000n * 10n ** 18n * Q96) / (b - a), N0 - 6_960, N0);
    const f = await verdict([main([twoSided(2, 10_000n)]), { key: v4PoolKey(NATIVE, TOKEN, 3000, 60), tick: N0, sqrtPriceX96: sqrtRatioAtTick(N0), positions: [wall] }], { 2: DEAD, 5: WALLET });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/5` });
    // The same pool priced beyond the window (the token 4x dearer there: a LOWER tick) takes nothing inside it; its tokens
    // are counted beyond it.
    const far = N0 - 13_860;
    const [c, d] = [sqrtRatioAtTick(far - 6_960), sqrtRatioAtTick(far)];
    const beyond = await verdict([main([twoSided(2, 10_000n)]), { key: v4PoolKey(NATIVE, TOKEN, 3000, 60), tick: far, sqrtPriceX96: sqrtRatioAtTick(far), positions: [nft(5, (50_000_000n * 10n ** 18n * Q96) / (d - c), far - 6_960, far)] }], { 2: DEAD, 5: WALLET });
    expect(beyond.status).toBe("warn");
    expect(beyond.detail).toMatch(/Wallets also hold (49\.9|50)M tokens in positions above twice that price/);
  });

  it("H. a fresh single-sided launch in a wallet, nobody has bought yet: a fail, where no USDC anywhere used to be unknown", async () => {
    const f = await verdict([main([launch(1)])], { 1: WALLET });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toBe(`Of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw and 0% into burned or locked ones. ${ORDER}`);
  });

  it("the same launch burned passes: a launchpad's single-sided position, with room for buyers' money", async () => {
    const f = await verdict([main([launch(1)])], { 1: DEAD });
    expect(f).toMatchObject({ status: "pass", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toBe(`Of the first 1,000 USDC buyers would pay for this token, 100% goes into burned or locked positions (burned: 100%, locked: 0%). ${ORDER}`);
  });

  it("J. the wallet's range is first in line; burned free tokens later in the window and burned bids don't change who is paid first", async () => {
    const first = nft(1, tokenOnlyL(T0, T0 + 960, 10_000_000n), T0, T0 + 960); // $0.001 to $0.0011: 10,476 USDC
    const late = nft(2, tokenOnlyL(T0 + 6_000, T0 + 6_900, 1_000_000_000n), T0 + 6_000, T0 + 6_900); // 1.82x to 1.99x
    const bids = nft(3, quoteOnlyL(T0 - 6_960, T0 - 60, 1_500n), T0 - 6_960, T0 - 60);
    const f = await verdict([main([first, late, bids])], { 1: WALLET, 2: DEAD, 3: DEAD });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toMatch(/^Of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw and 0% into burned or locked ones\. Of the 1,499 USDC in its pools now, wallets' positions hold 0 and burned or locked ones 1,499\./);
    // The other way round, burned first and the wallet later in the window: buyers do pay the burned range first, and the
    // wallet's share of everything paid by then is what counts.
    const burnedFirst = await verdict([main([{ ...first, salt: salt(2) }, { ...late, salt: salt(1) }, bids])], { 1: WALLET, 2: DEAD, 3: DEAD });
    expect(burnedFirst.status).toBe("fail");
    const smallLate = nft(1, tokenOnlyL(T0 + 6_000, T0 + 6_900, 100_000n), T0 + 6_000, T0 + 6_900);
    expect((await verdict([main([{ ...first, salt: salt(2) }, smallLate, bids])], { 1: WALLET, 2: DEAD, 3: DEAD })).status).toBe("pass");
  });
});

describe("earlier cases, under the price-ordered rule", () => {
  it("launch: a wallet keeps the in-range position with all the USDC, and a 980M-token range far above the price is burned", async () => {
    const sqrtP = sqrtRatioAtTick(T0) + 1n;
    const [rLo, rHi] = [T0 - 6_000, T0 + 6_000];
    const inRange = (10_000n * 10n ** 6n * Q96) / (sqrtP - sqrtRatioAtTick(rLo));
    const [bLo, bHi] = [T0 + 39_120, T0 + 69_060];
    const f = await verdict([{ key: MAIN, sqrtPriceX96: sqrtP, tick: T0, positions: [nft(1, inRange, rLo, rHi), nft(2, tokenOnlyL(bLo, bHi, 980_000_000n), bLo, bHi)] }], { 1: WALLET, 2: DEAD });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toMatch(/Of the 9,999 USDC in its pools now, wallets' positions hold 9,999 and burned or locked ones 0\./);
  });

  it("a burned token wall right above the price beside a wallet that holds every USDC in the pool: buyers do pay the wall, the money there is the wallet's", async () => {
    const holdsAll = nft(1, quoteOnlyL(T0 - 600, T0, 5_000n), T0 - 600, T0);
    const f = await verdict([main([holdsAll, launch(2, 900_000_000n)])], { 1: WALLET, 2: DEAD });
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/100% into burned or locked ones\. Of the 4,999 USDC in its pools now, wallets' positions hold 4,999 and burned or locked ones 0\./);
  });

  it("a wallet's range just above the price, beside a small burned in-range position, doesn't pass", async () => {
    const f = await verdict([main([twoSided(1, 1_500n), nft(2, tokenOnlyL(T0, T0 + 600, 50_000_000n), T0, T0 + 600)])], { 1: DEAD, 2: WALLET });
    expect(f.status).toBe("fail");
    // A small one is a warning, never a pass.
    expect((await verdict([main([twoSided(1, 5_000n), nft(2, tokenOnlyL(T0, T0 + 600, 500_000n), T0, T0 + 600)])], { 1: DEAD, 2: WALLET })).status).toBe("warn");
  });

  describe("a side pool at an absurd price", () => {
    const dust = nft(2, 10n ** 20n, 610_000, 620_000); // 2.2e-12 tokens above tick 600,000, where a raw token is 1e26 raw USDC
    const decoy: PoolSetup = { key: SIDE, sqrtPriceX96: sqrtRatioAtTick(600_000), tick: 600_000, positions: [dust] };
    it("can't pass a wallet-held pool by burning a dust position in it", async () => {
      expect((await verdict([main([twoSided(1, 30_000n)]), decoy], { 1: WALLET, 2: DEAD })).status).toBe("fail");
    });
    it("can't fail, or warn, a burned launch by a stranger's dust position in it: it lies far beyond the window, and it is dust", async () => {
      expect((await verdict([main([twoSided(1, 30_000n)]), decoy], { 1: DEAD, 2: WALLET_2 })).status).toBe("pass");
    });
  });

  it("a stranger's dust at a near-zero price doesn't move the window or the verdict of a burned launch", async () => {
    // Tick -900,000 is out of range for a pool; -800,000 is 1e-20 of the price. The dust sells 1e-6 of a token on the way up.
    const cheap = -800_000;
    const dust = nft(2, tokenOnlyL(cheap, cheap + 6_000, 1n) / 10n ** 6n, cheap, cheap + 6_000);
    const f = await verdict([main([twoSided(1, 30_000n)]), { key: SIDE, sqrtPriceX96: sqrtRatioAtTick(cheap), tick: cheap, positions: [dust] }], { 1: DEAD, 2: WALLET_2 });
    expect(f.status).toBe("pass");
    // A stranger's real asks below the launch price are paid first, as they would be: about 50 USDC of them is a warning.
    const under = nft(2, tokenOnlyL(T0 - 600, T0 - 60, 80_000n), T0 - 600, T0 - 60);
    const side: PoolSetup = { key: SIDE, sqrtPriceX96: sqrtRatioAtTick(T0 - 600), tick: T0 - 600, positions: [under] };
    expect((await verdict([main([twoSided(1, 30_000n)]), side], { 1: DEAD, 2: WALLET_2 })).status).toBe("warn");
    expect((await verdict([main([twoSided(1, 30_000n)]), { ...side, positions: [nft(2, tokenOnlyL(T0 - 600, T0 - 60, 20_000n), T0 - 600, T0 - 60)] }], { 1: DEAD, 2: WALLET_2 })).status).toBe("pass");
  });

  describe("a wallet's sell wall in another pool than the burned one", () => {
    const poolA = main([twoSided(1, 5_000n)]);
    const wallet = (tick: number): PoolSetup => ({ key: v4PoolKey(TOKEN, USDC, 10_000, 200), sqrtPriceX96: sqrtRatioAtTick(tick), tick, positions: [nft(2, tokenOnlyL(tick + 200, tick + 3_200, 200_000_000n), tick + 200, tick + 3_200)] });
    const owned = { 1: DEAD, 2: WALLET };
    it("fails with the wall at the burned pool's price, and with it cheaper: buyers are routed to the cheapest tokens first", async () => {
      expect((await verdict([poolA, wallet(T0)], owned)).status).toBe("fail");
      expect((await verdict([poolA, wallet(T0 - 13_800)], owned)).status).toBe("fail");
    });
    it("doesn't pass with the wall anywhere inside the window, and warns with it beyond: its tokens are counted", async () => {
      expect((await verdict([poolA, wallet(T0 + 5_800)], owned)).status).not.toBe("pass");
      const far = await verdict([poolA, wallet(T0 + 20_000)], owned);
      expect(far.status).toBe("warn");
      expect(far.detail).toMatch(/Wallets also hold (199\.9|200)M tokens in positions above twice that price/);
    });
  });
});

describe("tokens for sale beyond the window", () => {
  // Burned liquidity from the price to twice it selling a million tokens, and a wall just past that.
  const burnedWindow = nft(1, tokenOnlyL(T0, HI, 1_000_000n), T0, HI);
  // The window ends at twice the price at which 1,000 USDC has been paid: for the million-token range, about 3.2x.
  const wall = (tokens: bigint) => nft(2, tokenOnlyL(T0 + 13_020, T0 + 19_020, tokens), T0 + 13_020, T0 + 19_020);
  const INFLATED: TokenFacts = { supply: 10n ** 12n * 10n ** 18n, decimals: 18 };

  it("a supply inflated a thousandfold doesn't hide a wallet's wall: 0.9% of it is 9,000 times what the window sells", async () => {
    const f = await verdict([main([burnedWindow, wall(9_000_000_000n)])], { 1: DEAD, 2: WALLET }, {}, INFLATED);
    expect(f.status).toBe("warn");
    expect(f.detail).toMatch(/Wallets also hold (8\.9|9)B tokens in positions above twice that price/);
  });

  it("is material from 1% of the supply or 10% of the tokens the window sells, whichever comes first", async () => {
    // The window sells about a million tokens. 50,000 beyond it: 5% of that, and nothing of the supply.
    expect((await verdict([main([burnedWindow, wall(50_000n)])], { 1: DEAD, 2: WALLET }, {}, INFLATED)).status).toBe("pass");
    expect((await verdict([main([burnedWindow, wall(150_000n)])], { 1: DEAD, 2: WALLET }, {}, INFLATED)).status).toBe("warn");
    // 1% of a supply of ten million, though only 0.1% of what a larger window sells.
    const big = nft(1, tokenOnlyL(T0, HI, 100_000_000n), T0, HI);
    expect((await verdict([main([big, wall(101_000n)])], { 1: DEAD, 2: WALLET }, {}, { supply: 10n ** 25n, decimals: 18 })).status).toBe("warn");
    expect((await verdict([main([big, wall(101_000n)])], { 1: DEAD, 2: WALLET }, {}, FACTS)).status).toBe("pass");
  });

  it("is material at any amount when the supply isn't known", async () => {
    expect((await verdict([main([burnedWindow, wall(10n)])], { 1: DEAD, 2: WALLET }, {}, { supply: null, decimals: null })).status).toBe("warn");
    expect((await verdict([main([burnedWindow])], { 1: DEAD }, {}, { supply: null, decimals: null })).status).toBe("pass");
  });

  it("blocks a pass, as unknown, when a contract holds the wall: it isn't burned or locked, and it isn't a wallet", async () => {
    const f = await verdict([main([burnedWindow, wall(9_000_000_000n)])], { 1: DEAD, 2: CONTRACT }, { chain: { code: { [CONTRACT]: "0x6080" } } }, INFLATED);
    expect(f).toMatchObject({ status: "unknown", fixAppId: null });
    expect(f.detail).toMatch(/^(8\.9|9)B tokens are for sale above twice that price from positions that are neither burned, locked nor a wallet's\./);
    // Burned beyond the window: nothing to say.
    expect((await verdict([main([burnedWindow, wall(9_000_000_000n)])], { 1: DEAD, 2: DEAD }, {}, INFLATED)).status).toBe("pass");
  });
});

describe("a pool whose hook runs in swaps can't move the window", () => {
  it("a decoy with a cheap burned wall nobody can buy from doesn't hide a wallet's launch: the path starts where swaps are safe", async () => {
    // H: a hook with BEFORE_SWAP, priced at a hundredth of the real price, a burned wall with 1.4 million USDC of room on paper.
    const cheap = T0 - 46_080;
    const decoy: PoolSetup = { key: v4PoolKey(TOKEN, USDC, 100, 60, hookWith("0080")), listed: true, sqrtPriceX96: sqrtRatioAtTick(cheap), tick: cheap, positions: [nft(2, tokenOnlyL(cheap, cheap + 6_960, 100_000_000_000n), cheap, cheap + 6_960)] };
    const f = await verdict([main([launch(1)]), decoy], { 1: WALLET, 2: DEAD });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toMatch(/^Of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw/);
  });

  it("the same decoy beside a burned launch withholds its pass, from 5% of what buyers would pay; smaller ones change nothing", async () => {
    const cheap = T0 - 46_080;
    const decoy = (tokens: bigint): PoolSetup => ({ key: v4PoolKey(TOKEN, USDC, 100, 60, hookWith("0080")), listed: true, sqrtPriceX96: sqrtRatioAtTick(cheap), tick: cheap, positions: [nft(2, tokenOnlyL(cheap, cheap + 6_960, tokens), cheap, cheap + 6_960)] });
    // 1.4 million USDC of room on paper, which nobody here can tell from tokens buyers really get: unknown, never a fail.
    const f = await verdict([main([launch(1)]), decoy(100_000_000_000n)], { 1: DEAD, 2: DEAD });
    expect(f).toMatchObject({ status: "unknown", fixAppId: null });
    expect(f.detail).toMatch(/goes to burned or locked positions in a pool whose hook runs in every swap/);
    // 14 USDC of room: under 5% of the first 1,000.
    expect((await verdict([main([launch(1)]), decoy(1_000_000n)], { 1: DEAD, 2: DEAD })).status).toBe("pass");
  });

  it("a burned range in a hookless pool priced higher doesn't hide a wallet's launch in a swap-hooked pool below it: the wallet is paid first", async () => {
    // The real market: a wallet's launch range from the price to twice it, in a pool whose hook runs in swaps.
    const hooked = v4PoolKey(TOKEN, USDC, 100, 60, hookWith("0080"));
    // The cover: a hookless pool initialised at four times the price, with a burned range worth 1,400 USDC on paper.
    const high = T0 + 13_860;
    const cover: PoolSetup = { key: MAIN, sqrtPriceX96: sqrtRatioAtTick(high), tick: high, positions: [nft(2, tokenOnlyL(high, high + 6_960, 250_000n), high, high + 6_960)] };
    const f = await verdict([main([launch(1)], hooked), cover], { 1: WALLET, 2: DEAD });
    expect(f).toMatchObject({ status: "fail", fixAppId: "vault", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toMatch(/9\d(\.\d)?% goes into positions wallets can withdraw/);
    // The same two pools with the wallet's range burned too: the hook stands in front of it, so no pass either.
    expect((await verdict([main([launch(1)], hooked), cover], { 1: DEAD, 2: DEAD })).status).toBe("unknown");
  });

  it("anchors on the swap-hooked pools when there is no other with tokens for sale", async () => {
    const hooked = v4PoolKey(TOKEN, USDC, 100, 60, hookWith("0080"));
    expect((await verdict([main([launch(1)], hooked)], { 1: WALLET })).status).toBe("fail");
    expect((await verdict([main([launch(1)], hooked)], { 1: DEAD })).status).toBe("unknown");
    // A burned launchpad range reaching far past the window: its tokens up there are said to be burned behind the hook.
    const wide = nft(1, tokenOnlyL(T0, T0 + 60_000, 800_000_000n), T0, T0 + 60_000);
    const f = await verdict([main([wide], hooked)], { 1: DEAD });
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/M tokens are for sale above twice that price from burned or locked positions in a pool whose hook runs in every swap\./);
    expect(f.detail).not.toMatch(/neither burned/);
  });

  it("counts a swap-hooked pool's positions inside the window, by their class there", async () => {
    // A burned launch in a hookless pool, and as much again burned in a swap-hooked pool at the same price: half of what
    // buyers pay goes to positions the hook stands in front of.
    const hooked = v4PoolKey(TOKEN, USDC, 100, 60, hookWith("0080"));
    const f = await verdict([main([launch(1)]), { ...main([launch(2)], hooked) }], { 1: DEAD, 2: DEAD });
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/^50% of the first 2,000 USDC buyers would pay goes to burned or locked positions in a pool whose hook runs in every swap/);
  });
});

describe("the token as currency1", () => {
  // HIGH sorts above USDC, so USDC is currency0 and every tick is mirrored: $0.001 a token is tick +345,420 or so with
  // 6-decimal USDC and an 18-decimal token.
  const H0 = 345_420;
  const highKey = v4PoolKey(HIGH, USDC, 3000, 60);
  const over = { token: HIGH as `0x${string}` };
  /** A token-only range for this pair: BELOW the tick (a higher token price), holding `tokens`. */
  const asks = (id: number, tokens: bigint, from = H0, width = 6_960) => {
    const [a, b] = [sqrtRatioAtTick(from - width), sqrtRatioAtTick(from)];
    return nft(id, (tokens * 10n ** 18n * Q96) / (b - a), from - width, from);
  };
  const pool = (positions: FakePosition[]): PoolSetup => ({ key: highKey, tick: H0, sqrtPriceX96: sqrtRatioAtTick(H0), positions });

  it("reads asks and bids the right way up", async () => {
    expect((await verdict([pool([asks(1, 100_000_000n)])], { 1: WALLET }, over)).status).toBe("fail");
    expect((await verdict([pool([asks(1, 100_000_000n)])], { 1: DEAD }, over)).status).toBe("pass");
    // A wallet's range first in line, a burned one later in the window: J, mirrored.
    const first = asks(1, 10_000_000n, H0, 960);
    const late = asks(2, 1_000_000_000n, H0 - 6_000, 900);
    expect((await verdict([pool([first, late])], { 1: WALLET, 2: DEAD }, over)).status).toBe("fail");
    // A wallet's range beyond the window: counted in tokens.
    const beyond = await verdict([pool([asks(1, 100_000_000n), asks(2, 300_000_000n, H0 - 20_000, 6_000)])], { 1: DEAD, 2: WALLET }, over);
    expect(beyond.status).toBe("warn");
    expect(beyond.detail).toMatch(/Wallets also hold (299\.9|300)M tokens in positions above twice that price/);
  });
});

describe("an index that can't be relied on for a pool is unknown, never a pass or a fail", () => {
  const burned = { chain: owners({ 7: DEAD }) };
  it("has no entry for the pool", async () => {
    const f = await lpLock([nft(7, L)], { ...burned, index: { cursor: Number(HEAD), pools: {} } });
    expect(f).toMatchObject({ status: "unknown", detail: "The position index has no entry yet for a Uniswap v4 pool of this token.", fixAppId: null });
  });
  it("is truncated", async () => {
    const f = await lpLock([nft(7, L)], { ...burned, index: { cursor: Number(HEAD), pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: true } } } });
    expect(f).toMatchObject({ status: "unknown", detail: "A Uniswap v4 pool of this token has more than 500 positions, more than this check reads." });
  });
  it("lists positions that don't add up to the pool's liquidity: a gap in the index", async () => {
    const f = await lpLock([nft(7, L), nft(8, L)], { chain: owners({ 7: DEAD, 8: WALLET }), index: { cursor: Number(HEAD), pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: false } } } });
    expect(f).toMatchObject({ status: "unknown", detail: "The position index has a gap: the positions it lists for a Uniswap v4 pool don't add up to the pool's liquidity." });
    expect(f.detail).not.toMatch(/catching up/);
  });
  it("names a position that doesn't answer", async () => {
    const f = await lpLock([nft(7, L)], { chain: { ...burned.chain, positionInfoFails: true } });
    expect(f).toMatchObject({ status: "unknown", detail: "The positions of a Uniswap v4 pool couldn't be read." });
  });

  it("finds a position opened after the index's cursor, so a fresh wallet position still counts", async () => {
    const opened: ChainLog = { topics: [MODIFY_LIQUIDITY_TOPIC, id, topic(PM)], data: `0x${"f".repeat(58)}fffda8${"0".repeat(58)}000258${"0".repeat(63)}1${salt(8).slice(2)}`, blockNumber: 950n };
    const { input, reader } = world([{ key, positions: [nft(7, 40n * L), nft(8, 60n * L)] }], {
      chain: { ...owners({ 7: DEAD, 8: WALLET }), logs: [opened] },
      index: { cursor: 900, pools: { [id]: { positions: [keyOf(nft(7, 40n * L))], truncated: false } } },
    });
    expect(await checkLpLock(input, await findPools(input))).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/8` });
    // The token's new pools on either side of a pair, then the pools' positions.
    expect(reader.logQueries.map((q) => q.topics[0])).toEqual([INITIALIZE_TOPIC, INITIALIZE_TOPIC, MODIFY_LIQUIDITY_TOPIC]);
  });

  it("reads a pool created after the cursor from the tail alone: it needs no entry in the index", async () => {
    const logs: ChainLog[] = [
      { topics: [INITIALIZE_TOPIC, id, topic(TOKEN), topic(USDC)], data: "0x", blockNumber: 940n },
      { topics: [MODIFY_LIQUIDITY_TOPIC, id, topic(PM)], data: `0x${"f".repeat(58)}fffda8${"0".repeat(58)}000258${"0".repeat(63)}1${salt(8).slice(2)}`, blockNumber: 950n },
    ];
    const f = await lpLock([nft(8, L)], { chain: { ...owners({ 8: WALLET }), logs }, index: { cursor: 900, pools: {} } });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/8` });
  });
});

describe("pools the lookup may not have", () => {
  // A small hookless pool whose NFT is burned, beside a pool with a hook (or an odd fee) that holds most of the liquidity in
  // a wallet's position. Discovery probes the standard hookless keys only, so the big pool is seen only when the index
  // lists it (`extraPools`), which is why the indexer's position step records every v4 pool.
  const big = v4PoolKey(TOKEN, USDC, 7_777, 200, hookWith("00c0"));
  const bigId = v4PoolId(big);
  const burned = nft(1, L);
  const kept = nft(2, 50n * L);
  const chain: FakeChain = { nftOwners: { 1: DEAD, 2: WALLET } };

  it("fails on the wallet's share once the index lists the hooked pool, where the burned pool alone would have passed", async () => {
    const f = await check([{ key, positions: [burned] }, { key: big, positions: [kept], listed: true }], { chain });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/2` });
    expect(f.detail).toMatch(/^Of the first [\d,]+ USDC buyers would pay for this token, 98% goes into positions wallets can withdraw and 2% into burned or locked ones\. Of the 1,507,203 USDC in its pools now, wallets' positions hold 1,477,650 and burned or locked ones 29,553\./);
  });

  it("can't answer when the hooked pool was created after the index's cursor and the lookup doesn't have it", async () => {
    const created: ChainLog = { topics: [INITIALIZE_TOPIC, bigId, topic(TOKEN), topic(USDC)], data: "0x", blockNumber: 950n };
    const f = await check([{ key, positions: [burned] }], { chain: { ...chain, logs: [created] }, index: { cursor: 900, pools: { [id]: { positions: [keyOf(burned)], truncated: false } } } });
    expect(f).toMatchObject({
      status: "unknown",
      detail: "A Uniswap v4 pool of this token was created in the last minutes and isn't in the index yet, so its liquidity isn't counted.",
      fixAppId: null,
    });
  });

  it("ignores a new pool against a currency that isn't a quote: such pools are never counted", async () => {
    const other: ChainLog = { topics: [INITIALIZE_TOPIC, bigId, topic(TOKEN), topic("0x128cC466B61f542da60c70e3aA11c10e19B84EDB")], data: "0x", blockNumber: 950n };
    const f = await check([{ key, positions: [burned] }], { chain: { ...chain, logs: [other] }, index: { cursor: 900, pools: { [id]: { positions: [keyOf(burned)], truncated: false } } } });
    expect(f.status).toBe("pass");
  });

  describe("a pool list cut short", () => {
    // 50 empty pools the index lists before the real one: discovery reads 50 of the index's pools and stops.
    const decoys = Array.from({ length: MAX_EXTRA_POOLS }, (_, i): PoolSetup => ({ key: v4PoolKey(TOKEN, USDC, 4_000 + i, 60), positions: [], listed: true }));
    const real: PoolSetup = { key: big, positions: [kept], listed: true };
    const small: PoolSetup = { key, positions: [burned] };

    it("is said, not hidden: the 51st pool the index lists makes the answer unknown, where it used to pass over 51 pools", async () => {
      const { input } = world([small, ...decoys, real], { chain });
      const scan = await findPools(input);
      expect(scan.truncated).toBe(true);
      expect(scan.pools.some((p) => p.poolId === bigId)).toBe(false);
      expect(await checkLpLock(input, scan)).toMatchObject({
        status: "unknown",
        detail: "This token has more Uniswap v4 pools than are read (over 50), so its liquidity can't be added up.",
        fixAppId: null,
      });
    });

    it("isn't flagged at exactly 50 listed pools, or for the same pool listed twice", async () => {
      const { input } = world([small, real, ...decoys.slice(1)], { chain });
      const scan = await findPools(input);
      expect(scan.truncated).toBeUndefined();
      expect((await checkLpLock(input, scan)).status).toBe("fail");
      const twice: InspectInput = { ...input, extraPools: [...input.extraPools!, ...input.extraPools!] };
      expect((await findPools(twice)).truncated).toBeUndefined();
    });

    it("is a blocker too when the index's own read was cut short (`extraPoolsTruncated`), even with no v4 pool found", async () => {
      const { input } = world([small], { chain, input: { extraPoolsTruncated: true } });
      expect(await checkLpLock(input, await findPools(input))).toMatchObject({ status: "unknown", detail: "This token has more Uniswap v4 pools than are read (over 50), so its liquidity can't be added up." });
      const reads = {
        ...noPools({ quoteTokens: [USD], v2Factory: V2 }),
        [readKey(V2, "getPair", [TOKEN, USDC])]: PAIR,
        ...v2PairReads(PAIR, USDC, TOKEN, 5_000_000_000n),
        [readKey(PAIR, "totalSupply", [])]: 100n,
        [readKey(PAIR, "balanceOf", [NATIVE])]: 0n,
        [readKey(PAIR, "balanceOf", [DEAD])]: 100n,
      };
      const v2Only = world([], { chain: { reads }, dex: { quoteTokens: [USD], v2Factory: V2, v4: UNISWAP_V4 }, input: { extraPoolsTruncated: true } });
      expect((await checkLpLock(v2Only.input, await findPools(v2Only.input))).status).toBe("unknown");
    });
  });
});

describe("the inspection's deadline", () => {
  it("makes lp-lock unknown when its reads would outlast it, and leaves the rest of the report standing", async () => {
    const { input, reader } = world([{ key, positions: [nft(7, L)] }], { chain: { nftOwners: { 7: DEAD }, code: { [TOKEN]: "0x63a9059cbb00" } } });
    // The position reads never answer.
    const read = reader.read;
    input.reader = { ...reader, read: (address, abi, fn, args, options) => (options?.blockNumber === undefined ? read(address, abi, fn, args, options) : new Promise(() => {})) };
    vi.useFakeTimers();
    try {
      const pending = inspect({ ...input, deadlineAt: Date.now() + 5_000 });
      await vi.advanceTimersByTimeAsync(4_100);
      const report = await pending;
      expect(report.findings.find((f) => f.id === "lp-lock")).toEqual({
        id: "lp-lock", status: "unknown", title: "Couldn't check liquidity locks",
        detail: "Reading who holds the liquidity took longer than this inspection had.", evidenceUrl: null, fixAppId: null,
      });
      expect(report.findings.find((f) => f.id === "liquidity")?.status).toBe("pass");
      expect(report.findings).toHaveLength(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts nothing once the deadline has passed", async () => {
    const { input, reader } = world([{ key, positions: [nft(7, L)] }], { chain: owners({ 7: DEAD }) });
    const scan = await findPools(input);
    const before = reader.batches.length;
    expect(await checkLpLock({ ...input, deadlineAt: Date.now() + 500 }, scan)).toMatchObject({ status: "unknown", detail: "Reading who holds the liquidity took longer than this inspection had." });
    expect(reader.batches.length).toBe(before);
    expect(reader.logQueries).toEqual([]);
  });
});

describe("a whole inspection with the position index", () => {
  it("carries the finding in the report, reads through the inspection's own reader, and isn't degraded by it", async () => {
    const { input, reader } = world([{ key, positions: [nft(7, L)] }], { chain: { nftOwners: { 7: WALLET }, code: { [TOKEN]: "0x63a9059cbb00" } } });
    const report = await inspect(input);
    expect(report.findings.find((f) => f.id === "lp-lock")).toMatchObject({ status: "fail", title: "Liquidity isn't locked", fixAppId: "vault" });
    expect(report.degraded).toBe(false);
    expect(reader.batchBlocks.filter((b) => b !== undefined)).toEqual([HEAD - HEAD_MARGIN, HEAD - HEAD_MARGIN]);
  });

  it("counts a warning as a warning in the report", async () => {
    const { input } = world([{ key, positions: [nft(1, 90n * L), nft(2, 10n * L)] }], { chain: { nftOwners: { 1: DEAD, 2: WALLET }, code: { [TOKEN]: "0x63a9059cbb00" } } });
    const report = await inspect(input);
    expect(report.findings.find((f) => f.id === "lp-lock")).toMatchObject({ status: "warn", title: "Some liquidity isn't locked", fixAppId: "vault" });
    expect(report.counts.warn).toBeGreaterThanOrEqual(1);
    expect(report.passed).toBe(report.counts.pass);
  });

  it("marks the report degraded when the index's tail can't be read, and the finding unknown", async () => {
    const { input } = world([{ key, positions: [nft(7, L)] }], {
      chain: { nftOwners: { 7: DEAD }, code: { [TOKEN]: "0x63a9059cbb00" }, logs: new Error("ECONNRESET") },
      index: { cursor: 900, pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: false } } },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const report = await inspect(input);
    quiet.mockRestore();
    expect(report.findings.find((f) => f.id === "lp-lock")).toMatchObject({ status: "unknown", fixAppId: null });
    expect(report.degraded).toBe(true);
  });
});

describe("pools of other kinds beside a v4 pool", () => {
  /** A v2 pair at the v4 pool's price: 1e-15 raw USDC a raw token, $0.001. */
  const pair = (lpBurned: bigint, usdc: bigint, quote = USDC) => ({
    ...noPools(everything),
    [readKey(V2, "getPair", [TOKEN, quote])]: PAIR,
    ...v2PairReads(PAIR, quote, TOKEN, usdc * 10n ** 6n, usdc * 10n ** 21n),
    [readKey(PAIR, "totalSupply", [])]: 100n,
    [readKey(PAIR, "balanceOf", [NATIVE])]: 0n,
    [readKey(PAIR, "balanceOf", [DEAD])]: lpBurned,
  });
  /** A v3 pool holding `usdc` and `tokens` (whole units of each). */
  const v3 = (usdc: bigint, tokens: bigint | null) => ({
    [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: V3_POOL,
    [readKey(USDC, "balanceOf", [V3_POOL])]: usdc * 10n ** 6n,
    ...(tokens === null ? {} : { [readKey(TOKEN, "balanceOf", [V3_POOL])]: tokens * 10n ** 18n }),
  });
  const both = (positions: FakePosition[], reads: Record<string, unknown>, nftOwners: Record<number, string>, input: Partial<InspectInput> = {}) =>
    verdict([main(positions)], nftOwners, { dex: everything, chain: { reads }, input });

  it("puts a v2 pair on the same path and in the same bids: a burned pair doesn't hide a wallet's v4 position, nor the other way round", async () => {
    expect((await both([twoSided(7, 2_000n)], pair(100n, 2_000n), { 7: DEAD })).status).toBe("pass");
    const walletV4 = await both([twoSided(7, 2_000n)], pair(100n, 2_000n), { 7: WALLET });
    expect(walletV4).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/7` });
    expect(walletV4.detail).toMatch(/Of the 3,999 USDC in its pools now, wallets' positions hold 1,999 and burned or locked ones 2,000\./);
    const walletLp = await both([twoSided(7, 2_000n)], pair(0n, 2_000n), { 7: DEAD });
    expect(walletLp).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PAIR}?tab=holders` });
  });

  it("splits a v2 pair by LP holder: a small unlocked share is a warning, LP in a known locker is locked, unvetted lockers leave it unknown", async () => {
    expect((await both([twoSided(7, 2_000n)], pair(80n, 2_000n), { 7: DEAD })).status).toBe("warn");
    const locked = await both([twoSided(7, 2_000n)], { ...pair(50n, 2_000n), [readKey(PAIR, "balanceOf", [LOCKER])]: 50n }, { 7: DEAD }, { knownLockers: [LOCKER] });
    expect(locked).toMatchObject({ status: "pass", detail: expect.stringMatching(/100% goes into burned or locked positions \(burned: 8\d(\.\d)?%, locked: 1\d(\.\d)?%\)/) as string });
    const unvetted = await both([twoSided(7, 2_000n)], pair(10n, 2_000n), { 7: DEAD }, { lockersVetted: false });
    expect(unvetted.status).toBe("unknown");
    expect(unvetted.detail).toMatch(/goes to v2 LP outside burn addresses and known lock contracts, where the lock contracts on Arc aren't recognized yet\./);
  });

  it("a v2 pair sells all the way up: it alone reaches the window however thin its start", async () => {
    // 600 USDC in a burned pair: buyers have paid 1,000 into it by the time the price is 7.1 times higher.
    const { input } = world([{ key: MAIN, tick: T0, sqrtPriceX96: sqrtRatioAtTick(T0), positions: [] }], { dex: everything, chain: { reads: pair(100n, 600n) }, input: { extraPoolsTruncated: undefined } });
    const tally = (await tallyLiquidity({ ...input, extraPools: [{ version: "v4", key: MAIN }] }, await findPools(input), everything))!;
    expect(tally.path).toMatchObject({ reached: true });
    expect(tally.path!.prefixes[0]!.burned / SHARE_SCALE).toBeGreaterThanOrEqual(1_000_000_000n);
    expect(tally.bids.burned).toBe(600_000_000n * SHARE_SCALE);
  });

  it("a v3 pool's USDC is unknown, and so is whose its tokens are: a small one beside burned liquidity still passes", async () => {
    // 50 USDC and 100,000 tokens: 2.4% of the USDC in the pools, 0.01% of the supply, 0.3% of what the window sells.
    expect((await both([twoSided(7, 2_000n)], { ...noPools(everything), ...v3(50n, 100_000n) }, { 7: DEAD })).status).toBe("pass");
  });

  it("a v3 pool holding a material amount of tokens blocks a pass, at any price: its asks can't be read", async () => {
    const f = await both([twoSided(7, 2_000n)], { ...noPools(everything), ...v3(50n, 20_000_000n) }, { 7: DEAD });
    expect(f).toMatchObject({ status: "unknown", fixAppId: null });
    expect(f.detail).toMatch(/^Uniswap v3 pools hold 20M tokens, and whose they are can't be read yet\./);
    // No slot0 is read, and none is needed: the pool's price changes nothing.
    const priced = await both([twoSided(7, 2_000n)], { ...noPools(everything), ...v3(50n, 20_000_000n), [readKey(V3_POOL, "slot0", [])]: [sqrtRatioAtTick(600_000), 600_000] }, { 7: DEAD });
    expect(priced.detail).toBe(f.detail);
  });

  it("a v3 pool whose token balance can't be read blocks a pass too", async () => {
    const f = await both([twoSided(7, 2_000n)], { ...noPools(everything), ...v3(50n, null) }, { 7: DEAD });
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/^Uniswap v3 pools' token balances couldn't be read\./);
  });

  it("a v3 pool holding a material share of the USDC is unknown too", async () => {
    const f = await both([twoSided(7, 2_000n)], { ...noPools(everything), ...v3(2_000n, 1n) }, { 7: DEAD });
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/^50% of the 3,999 USDC in its pools now sits with Uniswap v3 pools, whose positions can't be read yet\./);
    expect(f.evidenceUrl).toBe(`https://explorer.test/address/${V3_POOL}`);
  });

  it("is unknown while a family of pools never answered", async () => {
    const { input } = world([], { dex: everything, chain: { reads: pair(100n, 5_000n), multicallReverts: true }, input: { extraPoolsTruncated: true } });
    const f = await checkLpLock(input, await findPools(input));
    expect(f.status).toBe("unknown");
    expect(f.detail).toContain("Uniswap v4 and Aerodrome didn't answer, so a pool there can't be ruled out.");
  });

  it("names both currencies when the pools quote in both", async () => {
    const f = await both([twoSided(7, 2_000n)], pair(100n, 2_000n, EURC.mainnet), { 7: WALLET });
    expect(f.detail).toMatch(/Of the 3,999 USDC\/EURC in its pools now/);
  });
});

describe("where the check is the one from before the index, unchanged", () => {
  const pairReads = (lpBurned: bigint) => ({
    [readKey(V2, "getPair", [TOKEN, USDC])]: PAIR,
    ...v2PairReads(PAIR, USDC, TOKEN, 5_000_000_000n),
    [readKey(PAIR, "totalSupply", [])]: 100n,
    [readKey(PAIR, "balanceOf", [NATIVE])]: 0n,
    [readKey(PAIR, "balanceOf", [DEAD])]: lpBurned,
  });
  const v2AndV4: DexConfig = { quoteTokens: [USD], v2Factory: V2, v4: UNISWAP_V4 };
  const without = (input: InspectInput): InspectInput => ({ ...input, v4Positions: undefined });

  it("a v2-only token keeps its rule and its words with a fresh index: no v4 pool is involved", async () => {
    for (const [burned, expected] of [
      [96n, { status: "pass", detail: "96% of the v2 LP supply can't be withdrawn." }],
      [10n, { status: "fail", detail: "90% of the v2 LP supply sits in wallets that can withdraw it.", fixAppId: "vault" }],
    ] as const) {
      const { input, reader } = world([], { dex: v2AndV4, chain: { reads: pairReads(burned) }, index: { cursor: 900, pools: {} } });
      const scan = await findPools(input);
      const f = await checkLpLock(input, scan);
      expect(f).toMatchObject(expected);
      expect(f).toEqual(await checkLpLock(without(input), scan));
      // The index's tail was asked whether the token gained a v4 pool, and nothing else of the new path ran.
      expect(reader.logQueries.map((q) => q.topics[0])).toEqual([INITIALIZE_TOPIC, INITIALIZE_TOPIC]);
    }
  });

  it("a v2 pair beside a v3 pool keeps the old rule too", async () => {
    const dex: DexConfig = { quoteTokens: [USD], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000], v4: UNISWAP_V4 };
    const reads = { ...pairReads(100n), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: V3_POOL, [readKey(USDC, "balanceOf", [V3_POOL])]: 9_000_000_000n };
    const { input } = world([], { dex, chain: { reads }, index: { cursor: 900, pools: {} } });
    expect(await checkLpLock(input, await findPools(input))).toMatchObject({ status: "unknown", detail: "The deepest pool is a Uniswap v3 position, which can't be read without an index yet." });
  });

  it("a v2-only token whose tail shows a new v4 pool is no longer v2-only", async () => {
    const created: ChainLog = { topics: [INITIALIZE_TOPIC, `0x${"c1".repeat(32)}`, topic(TOKEN), topic(USDC)], data: "0x", blockNumber: 950n };
    const { input } = world([], { dex: v2AndV4, chain: { reads: pairReads(100n), logs: [created] }, index: { cursor: 900, pools: {} } });
    expect(await checkLpLock(input, await findPools(input))).toMatchObject({ status: "unknown", detail: expect.stringContaining("was created in the last minutes") as string });
  });

  it("an index more than 10,000 blocks behind is not used at all: today's answers, and none of it read", async () => {
    const stale = { chain: { nftOwners: { 7: DEAD }, head: 50_000n }, index: { cursor: 30_000, pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: false } } } };
    const { input, reader } = world([{ key, positions: [nft(7, L)] }], stale);
    const scan = await findPools(input);
    const f = await checkLpLock(input, scan);
    expect(f).toEqual(await checkLpLock(without(input), scan));
    expect(f).toMatchObject({ status: "unknown", detail: "Only Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet." });
    expect(reader.logQueries).toEqual([]);
    expect(reader.batches.flatMap((b) => b.calls).map((c) => c.fn).filter((fn) => fn === "getPositionInfo" || fn === "ownerOf")).toEqual([]);

    // A v2 pair is judged as it was, alone or beside a v4 pool.
    const v2 = world([], { dex: v2AndV4, chain: { reads: pairReads(10n), head: 50_000n }, index: { cursor: 30_000, pools: {} } });
    expect(await checkLpLock(v2.input, await findPools(v2.input))).toMatchObject({ status: "fail", detail: "90% of the v2 LP supply sits in wallets that can withdraw it." });
    const beside = world([{ key, positions: [nft(7, L)] }], { dex: v2AndV4, chain: { reads: pairReads(100n), head: 50_000n, nftOwners: { 7: WALLET } }, index: { cursor: 30_000, pools: {} } });
    expect(await checkLpLock(beside.input, await findPools(beside.input))).toMatchObject({
      status: "unknown",
      detail: "A Uniswap v4 pool that may hold more than this v2 pair sits beside it, and positions in it can't be read without an index yet.",
    });
  });

  it("answers as before the index when no index is given", async () => {
    const f = await lpLock([nft(7, L)], { chain: owners({ 7: WALLET }), index: null });
    expect(f).toMatchObject({ status: "unknown", detail: "Only Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet." });
  });
});
