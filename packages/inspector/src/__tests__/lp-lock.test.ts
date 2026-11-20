import { describe, expect, it, vi } from "vitest";
import { AERODROME, EURC, UNISWAP_V4, USDC, type DexConfig } from "@arcos/chain";
import { SHARE_SCALE, checkLpLock, findPools, tallyLiquidity, type TokenFacts } from "../checks";
import { inspect } from "../inspect";
import type { ChainLog, ExtraPool, Finding, InspectInput, V4PositionIndex, V4PositionKey } from "../types";
import { MAX_EXTRA_POOLS, NATIVE, sqrtRatioAtTick, v4PoolId, v4PoolKey } from "../v4";
import { HEAD_MARGIN, INITIALIZE_TOPIC, MODIFY_LIQUIDITY_TOPIC } from "../v4-positions";
import { fakeChain, readKey, v2PairReads, type FakeChain, type FakePool, type FakePosition } from "./fixtures/chain-fake";
import { arcFields } from "./fixtures/arc";

// What the position index adds to lp-lock when a Uniswap v4 pool is involved: fails and warnings for liquidity wallets
// can withdraw, and never a pass. Everywhere it has nothing to add, the finding is the one from before the index
// (pools.test.ts and inspect.test.ts cover that check), word for word: `quiet` and `silent` below hold that line.

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

type PoolSetup = { key: ReturnType<typeof v4PoolKey>; positions: FakePosition[]; sqrtPriceX96?: bigint; tick?: number; listed?: boolean; lpFee?: number };
/** A chain with these v4 pools, and the index listing every position of each, caught up. */
function world(pools: PoolSetup[], over: { chain?: FakeChain; dex?: DexConfig; index?: V4PositionIndex | null; input?: Partial<InspectInput>; token?: `0x${string}` } = {}) {
  const v4: Record<string, FakePool> = {};
  const indexed: V4PositionIndex = { cursor: Number(HEAD - HEAD_MARGIN), pools: {} };
  for (const p of pools) {
    const tick = p.tick ?? 0;
    v4[v4PoolId(p.key)] = {
      sqrtPriceX96: p.sqrtPriceX96 ?? Q96,
      tick,
      // What slot0 says: the key's fee, or for a dynamic-fee pool whatever the hook last set.
      lpFee: p.lpFee ?? (p.key.fee === 0x800000 ? 0 : p.key.fee),
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
/** The finding for this world, which must be the one the check gives without the index: the new path said nothing. */
async function silent(pools: PoolSetup[], over: Parameters<typeof world>[1] = {}): Promise<Finding> {
  const { input } = world(pools, over);
  const scan = await findPools(input);
  const f = await checkLpLock(input, scan);
  expect(f).toEqual(await checkLpLock({ ...input, v4Positions: undefined }, scan));
  return f;
}

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
const ORDER = "Counted in the order buyers' money would arrive, by what a buyer pays per token in each pool, fee included, up to twice the price at which 1,000 USDC has been paid.";
/** A plain pool holding USDC only: 1,200 in a wallet's range and 5,000 in a burned one, so the bids alone fail nothing. */
const MONEY: PoolSetup = {
  key: v4PoolKey(TOKEN, USDC, 3000, 10), listed: true, tick: T0, sqrtPriceX96: sqrtRatioAtTick(T0),
  positions: [nft(91, quoteOnlyL(T0 - 960, T0 - 60, 1_200n), T0 - 960, T0 - 60), nft(92, quoteOnlyL(T0 - 960, T0 - 60, 5_000n), T0 - 960, T0 - 60)],
};
const MONEY_OWNERS = { 91: WALLET, 92: DEAD };
/**
 * Wallets in plain pools are paid half or more of some prefix: a fail when they hold 1,000 USDC in plain pools too, a
 * warning on the tokens alone, which becomes a fail once that money is beside them. Returns the finding as given.
 */
const paidToWallets = async (pools: PoolSetup[], nftOwners: Record<number, string>, over: Parameters<typeof world>[1] = {}, facts = FACTS) => {
  const f = await verdict(pools, nftOwners, over, facts);
  expect(["warn", "fail"]).toContain(f.status);
  if (f.status === "fail") return f;
  expect((await verdict([...pools, MONEY], { ...nftOwners, ...MONEY_OWNERS }, over, facts)).status).toBe("fail");
  return f;
};
/**
 * The new path has nothing to add: the finding is the one the check gives without the index, word for word, and that
 * one is never a pass for a token with a Uniswap v4 pool. Returns it.
 */
const quiet = async (pools: PoolSetup[], nftOwners: Record<number, string>, over: Parameters<typeof world>[1] = {}, facts = FACTS) => {
  const f = await verdict(pools, nftOwners, over, facts);
  const before = await verdict(pools, nftOwners, { ...over, index: null }, facts);
  expect(f).toEqual(before);
  expect(f.status).not.toBe("fail");
  expect(f.status).not.toBe("warn");
  if (pools.length > 0) expect(f.status).toBe("unknown");
  return f;
};

describe("lp-lock over a Uniswap v4 pool's positions", () => {
  it("fails when a wallet holds the liquidity: where buyers' money goes, what the wallet holds now, a Vault fix and the NFT's page", async () => {
    const f = await verdict([main([twoSided(7, 2_000n)])], { 7: WALLET });
    expect(f).toEqual({
      id: "lp-lock",
      status: "fail",
      title: "Liquidity isn't locked",
      detail: `Of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw and 0% into burned or locked ones. Of the 1,999 USDC in its pools now, wallets' positions hold 1,999 and burned or locked ones 0. Of that, 1,277 is within reach of sellers, down to half the price: wallets' positions hold 1,277 of it and burned or locked ones 0. ${ORDER}`,
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: "vault",
    });
  });

  it("adds nothing when the NFT sits at a burn address: the finding is the old check's, and no pass", async () => {
    const f = await quiet([main([twoSided(7, 2_000n)])], { 7: DEAD });
    expect(f).toEqual({
      id: "lp-lock",
      status: "unknown",
      title: "Couldn't check liquidity locks",
      detail: "Only Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet.",
      evidenceUrl: null,
      fixAppId: null,
    });
  });

  it("adds nothing when a known locker holds it, or a contract: neither is a wallet", async () => {
    await quiet([main([twoSided(1, 3_000n), twoSided(2, 1_000n)])], { 1: LOCKER, 2: NATIVE }, { input: { knownLockers: [LOCKER] } });
    await quiet([main([twoSided(7, 2_000n)])], { 7: CONTRACT }, { chain: { code: { [CONTRACT]: "0x6080" } } });
  });

  it("classifies a position held straight in the PoolManager by its sender: a wallet there fails, linked by its address; a contract doesn't", async () => {
    const own: FakePosition = { ...twoSided(0, 2_000n), owner: SENDER };
    expect(await verdict([main([own])], {})).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/address/${SENDER}` });
    await quiet([main([own])], {}, { chain: { code: { [SENDER]: "0x6080" } } });
  });

  it("counts an EIP-7702 wallet as a wallet", async () => {
    const f = await verdict([main([twoSided(7, 2_000n)])], { 7: WALLET }, { chain: { code: { [WALLET]: `0xef0100${"ab".repeat(20)}` } } });
    expect(f.status).toBe("fail");
  });

  describe("the lines: fail from 50% to wallets, warn above 5%, nothing at or under it", () => {
    // Every position over the same range, so every prefix and the bids give the same shares.
    const split = (burned: bigint, wallet: bigint, contract = 0n) =>
      verdict([main([twoSided(1, burned * 100n), twoSided(2, wallet * 100n), ...(contract > 0n ? [twoSided(3, contract * 100n)] : [])])], { 1: DEAD, 2: WALLET, 3: CONTRACT }, { chain: { code: { [CONTRACT]: "0x6080" } } });
    it("adds nothing at exactly 5% in a wallet", async () => {
      const [pools, nftOwners] = [[main([twoSided(1, 9_500n), twoSided(2, 500n)])], { 1: DEAD, 2: WALLET }];
      await quiet(pools, nftOwners);
    });
    it("warns just past 5% to wallets, with the Vault fix and what they hold", async () => {
      expect(await split(94n, 6n)).toMatchObject({
        status: "warn",
        title: "Some liquidity isn't locked",
        fixAppId: "vault",
        detail: `In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 6% goes into positions wallets can withdraw and 94% into burned or locked ones. Of the 9,999 USDC in its pools now, wallets' positions hold 599 and burned or locked ones 9,399. ${ORDER}`,
        evidenceUrl: `https://explorer.test/token/${PM}/instance/2`,
      });
    });
    it("warns just under half to wallets, and fails at exactly half", async () => {
      expect((await split(51n, 49n)).status).toBe("warn");
      expect(await split(50n, 50n)).toMatchObject({ status: "fail", title: "Liquidity isn't locked", fixAppId: "vault" });
      expect((await split(10n, 50n, 40n)).status).toBe("fail");
    });
    it("warns on a third party's 10% whoever holds the rest", async () => {
      expect((await split(0n, 10n, 90n)).status).toBe("warn");
    });
  });

  it("links the largest position that isn't safe", async () => {
    const f = await verdict([main([twoSided(1, 200n), twoSided(2, 500n), twoSided(3, 9_000n)])], { 1: WALLET, 2: WALLET_2, 3: DEAD });
    expect(f).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/2` });
  });

  it("drops positions that hold nothing, and has nothing to say of pools with nothing in them", async () => {
    await quiet([main([nft(1, 0n, LO, HI), twoSided(2, 2_000n)])], { 2: DEAD });
    await quiet([main([nft(1, 0n, LO, HI)])], { 1: WALLET });
  });

  it("warns on thin liquidity in a wallet, and never fails it: the wording has no window in it", async () => {
    // 100 USDC in the range now; buyers pay 142 into it before it runs out.
    const f = await verdict([main([twoSided(7, 100n)])], { 7: WALLET });
    expect(f.status).toBe("warn");
    // Nor with a wallet's 1,200 USDC beside it: with under 1,000 USDC of tokens for sale there is no market price to
    // measure reach from, and nothing fails.
    expect((await verdict([main([twoSided(7, 100n)]), MONEY], { 7: WALLET, ...MONEY_OWNERS })).status).toBe("warn");
    expect(f.detail).toBe(`In the pools Inspector can read, of the 142 USDC buyers could pay for the tokens now for sale, 100% goes into positions wallets can withdraw and 0% into burned or locked ones. Of the 99 USDC in its pools now, wallets' positions hold 99 and burned or locked ones 0. Counted in the order buyers' money would arrive, by what a buyer pays per token in each pool, fee included; the tokens for sale would take under 1,000 USDC in all.`);
    await quiet([main([twoSided(7, 100n)])], { 7: DEAD });
  });

  describe("a hook that runs when liquidity is removed", () => {
    const hooked = (flags: string) => v4PoolKey(TOKEN, USDC, 10_000, 60, hookWith(flags));
    it.each([["BEFORE_REMOVE_LIQUIDITY", "0200"], ["AFTER_REMOVE_LIQUIDITY", "0100"], ["AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA", "0001"]])("keeps a wallet's position from failing: %s can block or tax the withdrawal", async (_name, flags) => {
      await quiet([main([twoSided(7, 2_000n)], hooked(flags))], { 7: WALLET });
    });
    it("changes nothing when the hook has no remove-liquidity permission", async () => {
      await paidToWallets([main([twoSided(7, 2_000n)], hooked("2000"))], { 7: WALLET });
    });
  });

  describe("a hook that runs in swaps", () => {
    // The launchpad kind: BEFORE_SWAP, AFTER_SWAP and both of their RETURNS_DELTA flags (0x20cc on Arc mainnet).
    const swapHooked = v4PoolKey(TOKEN, USDC, 0, 200, hookWith("20cc"));
    it("adds nothing for a burned position there", async () => {
      await quiet([main([launch(7)], swapHooked)], { 7: DEAD });
    });
    it("warns on a wallet's position there, and no more: whether buyers reach it is the hook's to decide", async () => {
      const f = await verdict([main([launch(7)], swapHooked)], { 7: WALLET });
      expect(f).toMatchObject({ status: "warn", fixAppId: "vault" });
      expect(f.detail).toBe(`In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 100% would go into positions wallets can withdraw and 0% into burned or locked ones, if the hooks and fees of the pools selling it let buyers through. ${ORDER}`);
      // The USDC a wallet holds there is in the pool, hook or no hook; still no fail without a plain pool.
      const held = await verdict([main([twoSided(7, 2_000n)], swapHooked)], { 7: WALLET });
      expect(held.status).toBe("warn");
      expect(held.detail).toMatch(/Of the 1,999 USDC in its pools now, wallets' positions hold 1,999 \(1,999 of it behind a swap hook, a dynamic or high fee, or in a pool not quoted in USDC, where nobody may be able to sell into it\) and burned or locked ones 0\./);
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
    it("judges a launch range split over 100 wallets exactly as it does in one wallet: every holder is classified, in one call", async () => {
      const one = await paidToWallets([main([twoSided(2, 2_000n), launch(100)])], { 2: DEAD, 100: WALLET });
      const { positions, nftOwners } = split();
      const { input, reader } = world([main(positions)], { chain: { nftOwners } });
      const many = await checkLpLock(input, await findPools(input), FACTS);
      expect(one.status).toBe("warn");
      expect(many).toMatchObject({ status: "warn", detail: one.detail });
      expect(reader.codeReads).toEqual([100]);
    });
    it("says so in the warning when holders it couldn't classify could make it a fail", async () => {
      // The node won't run the batched read, so only the 40 largest are read: 60 of the 100 wallets stay unclassified.
      const { positions, nftOwners } = split();
      const f = await verdict([main(positions)], nftOwners, { chain: { codeReaderFails: new Error("no state override") } });
      expect(f).toMatchObject({ status: "warn", fixAppId: "vault" });
      expect(f.detail).toMatch(/goes into positions wallets can withdraw and .* 60 holders of this token's liquidity weren't classified, more than this check reads: with them, wallets could hold half or more\. Counted in the order/);
    });
    it("counts holders left unclassified as nobody's: they can't make a warning", async () => {
      const positions = [twoSided(2, 9_300n), ...Array.from({ length: 70 }, (_, i) => twoSided(100 + i, 10n))];
      const nftOwners = Object.fromEntries([[2, DEAD], ...positions.slice(1).map((_, i) => [100 + i, `0x${(0xb0b100 + i).toString(16).padStart(40, "0")}`])]) as Record<number, string>;
      // 40 wallets read (4%), 30 unclassified (3%).
      await quiet([main(positions)], nftOwners, { chain: { codeReaderFails: new Error("no state override") } });
    });
  });
});

describe("buyers' money in price order: the review's cases", () => {
  it("A. burned bids in a side pool priced 10x lower don't set the price: the wallet's launch range is first in line", async () => {
    const dTick = T0 - 23_030;
    const bids = nft(2, quoteOnlyL(dTick - 10_000, dTick - 10, 1_500n), dTick - 10_000, dTick - 10);
    const f = await verdict([main([launch(1)]), { key: SIDE, tick: dTick, sqrtPriceX96: sqrtRatioAtTick(dTick), positions: [bids] }], { 1: WALLET, 2: DEAD });
    expect(f).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toMatch(/^In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw/);
    // The same bids at the main pool's price: no different.
    const same = nft(2, quoteOnlyL(T0 - 10_000, T0 - 10, 1_500n), T0 - 10_000, T0 - 10);
    await paidToWallets([main([launch(1)]), { key: SIDE, tick: T0, sqrtPriceX96: sqrtRatioAtTick(T0), positions: [same] }], { 1: WALLET, 2: DEAD });
  });

  it("B. a burned range from half the price to twice it, and a wallet's range from just past that", async () => {
    // The window runs to twice the price at which 1,000 USDC has been paid, which is 1.3 times today's: 2.6x. A wall
    // starting at 2x is inside it, and takes most of what buyers pay there: a fail.
    const above = nft(3, tokenOnlyL(HI, HI + 39_120, 500_000_000n), HI, HI + 39_120);
    const inside = await verdict([main([twoSided(2, 2_000n), above])], { 2: DEAD, 3: WALLET });
    expect(inside).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/3` });
    // Starting at 4x it is beyond the window: a warning, with the tokens counted and no price put on them.
    const far = nft(3, tokenOnlyL(T0 + 13_860, T0 + 39_120, 500_000_000n), T0 + 13_860, T0 + 39_120);
    const f = await verdict([main([twoSided(2, 2_000n), far])], { 2: DEAD, 3: WALLET });
    expect(f).toMatchObject({ status: "warn", title: "Some liquidity isn't locked", fixAppId: "vault", evidenceUrl: `https://explorer.test/token/${PM}/instance/3` });
    expect(f.detail).toBe(
      `In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 0% goes into positions wallets can withdraw and 100% into burned or locked ones. Of the 1,999 USDC in its pools now, wallets' positions hold 0 and burned or locked ones 1,999. Wallets also hold 499.9M tokens in positions above twice that price, which buyers would pay into if the price rises that far. ${ORDER}`,
    );
  });

  it("C and D. a stranger's USDC parked as bids below a burned launch: a warning from 5% of the USDC in the pools, a fail only within reach of sellers", async () => {
    // Parked under half the price: nobody sells into it, and leaving it there risks nothing.
    const parked = (usdc: bigint) => nft(4, quoteOnlyL(T0 - 20_000, T0 - 7_020, usdc), T0 - 20_000, T0 - 7_020);
    // 2,000 beside 2,000 burned, or 200,000: half or all but all of the USDC in the pools, and out of reach.
    expect((await verdict([main([twoSided(2, 2_000n), parked(2_000n)])], { 2: DEAD, 4: WALLET_2 })).status).toBe("warn");
    expect((await verdict([main([twoSided(2, 2_000n), parked(200_000n)])], { 2: DEAD, 4: WALLET_2 })).status).toBe("warn");
    // 120 beside 2,000: 5.7%.
    expect((await verdict([main([twoSided(2, 2_000n), parked(120n)])], { 2: DEAD, 4: WALLET_2 })).status).toBe("warn");
    await quiet([main([twoSided(2, 2_000n), parked(100n)])], { 2: DEAD, 4: WALLET_2 });
  });

  it("bids within reach: what sellers would take by selling the token from the market price down to half of it", async () => {
    // A burned launch from the price up: the market price is where 1,000 USDC of it has been bought, a little above.
    const burned = launch(2);
    // 1,200 USDC at a hundredth of the price: none of it within reach. A warning, on what the pools hold.
    const deep = T0 - 46_080;
    const far = nft(4, quoteOnlyL(deep - 6_000, deep, 1_200n), deep - 6_000, deep);
    const f = await verdict([main([burned, far])], { 2: DEAD, 4: WALLET_2 });
    expect(f.status).toBe("warn");
    expect(f.detail).toBe("In the pools Inspector can read, of the 1,199 USDC in its pools now, wallets' positions hold 1,199 and burned or locked ones 0.");
    // The same 1,200 just under the price, where sellers can take it: all of what is within reach. A fail, and it says so.
    const near = nft(4, quoteOnlyL(T0 - 3_000, T0 - 60, 1_200n), T0 - 3_000, T0 - 60);
    const g = await verdict([main([burned, near])], { 2: DEAD, 4: WALLET_2 });
    expect(g.status).toBe("fail");
    expect(g.detail).toBe("Of the 1,199 USDC in its pools now, wallets' positions hold 1,199 and burned or locked ones 0. Of that, 1,199 is within reach of sellers, down to half the price: wallets' positions hold 1,199 of it and burned or locked ones 0.");
    // A range reaching from the price far down counts for its upper part: 3,000 USDC over [0.01x, 1x], a third or so in reach.
    const long = nft(4, quoteOnlyL(deep, T0 - 60, 3_000n), deep, T0 - 60);
    expect((await verdict([main([twoSided(2, 20_000n), long])], { 2: DEAD, 4: WALLET_2 })).status).toBe("warn");
    // A wallet launch whose 10,000 USDC sits in range: a fail, as the live ones are.
    expect((await verdict([main([twoSided(7, 10_000n)])], { 7: WALLET })).status).toBe("fail");
  });

  it("C1. a bids fail gives the figures it was decided on: a full-range burned position has under a third of its USDC within reach", async () => {
    const [MIN, MAX] = [-887_220, 887_220];
    const fullRange = nft(1, (10_000n * 10n ** 6n * Q96) / (sqrtRatioAtTick(T0) - sqrtRatioAtTick(MIN)), MIN, MAX);
    const near = (usdc: bigint) => nft(2, quoteOnlyL(T0 - 3_000, T0 - 60, usdc), T0 - 3_000, T0 - 60);
    const f = await verdict([main([fullRange, near(3_000n)])], { 1: DEAD, 2: WALLET });
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/^Of the 12,999 USDC in its pools now, wallets' positions hold 2,999 and burned or locked ones 9,999\. Of that, 5,210 is within reach of sellers, down to half the price: wallets' positions hold 2,999 of it and burned or locked ones 2,210\.$/);
    expect((await verdict([main([fullRange, near(2_000n)])], { 1: DEAD, 2: WALLET })).status).toBe("warn");
  });

  it("reach is measured from the market's price, not the pool's own: USDC in a pool initialised at a thousandth of the market is out of reach", async () => {
    const OFF = T0 - 69_080;
    const off = (usdc: bigint): PoolSetup => ({ key: SIDE, tick: OFF, sqrtPriceX96: sqrtRatioAtTick(OFF), positions: [nft(2, quoteOnlyL(OFF - 6_000, OFF - 10, usdc), OFF - 6_000, OFF - 10)] });
    const owned = { 1: DEAD, 2: WALLET_2 };
    // O-control: the same USDC that far down in the market's own pool.
    expect((await verdict([main([launch(1), nft(2, quoteOnlyL(OFF - 6_000, OFF - 10, 1_001n), OFF - 6_000, OFF - 10)])], owned)).status).toBe("warn");
    // O1: a fresh burned launch. O2: a burned launch holding 2,000 USDC in reach. O3: a launch burned behind a launchpad hook.
    expect((await verdict([main([launch(1)]), off(1_001n)], owned)).status).toBe("warn");
    expect((await verdict([main([twoSided(1, 2_000n)]), off(2_001n)], owned)).status).toBe("warn");
    expect((await verdict([{ ...main([launch(1)], v4PoolKey(TOKEN, USDC, 3000, 60, hookWith("2080"))), listed: true }, off(1_001n)], owned)).status).toBe("warn");
    // The token the other way up, and against native USDC: the same.
    const high = v4PoolKey(HIGH, USDC, 3000, 60);
    const H0 = 345_420;
    const [a, b] = [sqrtRatioAtTick(H0 - 6_960), sqrtRatioAtTick(H0)];
    const burnedHigh = nft(1, (100_000_000n * 10n ** 18n * Q96) / (b - a), H0 - 6_960, H0);
    const HOFF = H0 + 69_080;
    // Quote-only for a token that is currency1: ABOVE the tick, as currency0.
    const [c, d] = [sqrtRatioAtTick(HOFF + 10), sqrtRatioAtTick(HOFF + 6_000)];
    const parkedHigh = nft(2, (1_001n * 10n ** 6n * c * d) / (Q96 * (d - c)), HOFF + 10, HOFF + 6_000);
    const hOff = await verdict(
      [{ key: high, tick: H0, sqrtPriceX96: sqrtRatioAtTick(H0), positions: [burnedHigh] }, { key: v4PoolKey(HIGH, USDC, 500, 10), tick: HOFF, sqrtPriceX96: sqrtRatioAtTick(HOFF), positions: [parkedHigh] }],
      owned, { token: HIGH as `0x${string}` },
    );
    expect(hOff.status).toBe("warn");
  });

  it("AS1, AS-MM. a stranger's tokens far up, and money that isn't his or isn't in reach: no fail", async () => {
    const dustPool = (tokens: bigint): PoolSetup => ({ key: v4PoolKey(TOKEN, USDC, 100, 1), listed: true, tick: T0 + 68_940, sqrtPriceX96: sqrtRatioAtTick(T0 + 68_940), positions: [nft(2, tokenOnlyL(T0 + 69_000, T0 + 69_060, tokens), T0 + 69_000, T0 + 69_060)] });
    // AS1: a bought-through burned range (20,000 USDC, nothing left for sale), his 10 tokens, and his 1,001 USDC in a
    // pool initialised at a thousandth of the market.
    const boughtThrough = nft(1, quoteOnlyL(T0 - 6_960, T0, 20_000n), T0 - 6_960, T0);
    const OFF = T0 - 69_080;
    const offMoney: PoolSetup = { key: SIDE, tick: OFF, sqrtPriceX96: sqrtRatioAtTick(OFF), positions: [nft(3, quoteOnlyL(OFF - 6_000, OFF - 10, 1_001n), OFF - 6_000, OFF - 10)] };
    expect((await verdict([main([boughtThrough]), dustPool(10n), offMoney], { 1: DEAD, 2: WALLET_2, 3: WALLET_2 })).status).not.toBe("fail");
    // AS-MM: 19,000 burned USDC and a third party's 1,100 USDC of bids just under the price; nothing for sale but the
    // stranger's 10 tokens, or his 2,000 tokens that are 1,000 USDC on paper.
    const MM = "0x00000000000000000000000000000000000b0b03";
    const book = main([nft(1, quoteOnlyL(T0 - 6_960, T0, 19_000n), T0 - 6_960, T0), nft(4, quoteOnlyL(T0 - 3_000, T0 - 60, 1_100n), T0 - 3_000, T0 - 60)]);
    for (const tokens of [10n, 2_000n]) expect((await verdict([book, dustPool(tokens)], { 1: DEAD, 2: WALLET_2, 4: MM })).status, String(tokens)).not.toBe("fail");
    // The control, without the stranger: the third party's 5.5% of the USDC is a warning.
    expect((await verdict([book], { 1: DEAD, 4: MM })).status).toBe("warn");
  });

  it("a wallet's range bought through completely, with nothing left for sale anywhere: a warning on the USDC it holds", async () => {
    const f = await verdict([main([nft(1, quoteOnlyL(T0 - 6_960, T0, 20_000n), T0 - 6_960, T0)])], { 1: WALLET });
    expect(f.status).toBe("warn");
    expect(f.detail).toBe("In the pools Inspector can read, of the 19,999 USDC in its pools now, wallets' positions hold 19,999 and burned or locked ones 0.");
  });

  it("the review's shapes after buys still fail: the wallet's range holds what buyers paid", async () => {
    const BOUGHT = T0 + 120;
    const l100 = tokenOnlyL(T0, HI, 100_000_000n);
    const moved = (positions: FakePosition[]): PoolSetup => ({ key: MAIN, tick: BOUGHT, sqrtPriceX96: sqrtRatioAtTick(BOUGHT), positions });
    // H: 1.2% into the range, and 10%.
    expect((await verdict([moved([nft(1, l100, T0, HI)])], { 1: WALLET })).status).toBe("fail");
    expect((await verdict([{ ...moved([nft(1, l100, T0, HI)]), tick: T0 + 960, sqrtPriceX96: sqrtRatioAtTick(T0 + 960) }], { 1: WALLET })).status).toBe("fail");
    // K1: the 99%-fee burned decoy below the market.
    const D0 = T0 - 9_180;
    const decoy: PoolSetup = { key: v4PoolKey(TOKEN, USDC, 990_000, 60), listed: true, tick: D0, sqrtPriceX96: sqrtRatioAtTick(D0), positions: [nft(1, tokenOnlyL(D0, D0 + 1_800, 2_000_000_000n), D0, D0 + 1_800)] };
    expect((await verdict([moved([nft(2, l100, T0, HI)]), decoy], { 1: DEAD, 2: WALLET })).status).toBe("fail");
    // A: 1,500 burned USDC in a side pool priced 10x lower.
    const dTick = T0 - 23_030;
    const side: PoolSetup = { key: SIDE, tick: dTick, sqrtPriceX96: sqrtRatioAtTick(dTick), positions: [nft(2, quoteOnlyL(dTick - 10_000, dTick - 10, 1_500n), dTick - 10_000, dTick - 10)] };
    expect((await verdict([moved([nft(1, l100, T0, HI)]), side], { 1: WALLET, 2: DEAD })).status).toBe("fail");
    // J: the wallet's range first in line, burned free tokens late in the window, 1,500 burned bids.
    const first = nft(1, tokenOnlyL(T0, T0 + 960, 10_000_000n), T0, T0 + 960);
    const late = nft(2, tokenOnlyL(T0 + 6_000, T0 + 6_900, 1_000_000_000n), T0 + 6_000, T0 + 6_900);
    const bids = nft(3, quoteOnlyL(T0 - 6_960, T0 - 60, 1_500n), T0 - 6_960, T0 - 60);
    expect((await verdict([moved([first, late, bids])], { 1: WALLET, 2: DEAD, 3: DEAD })).status).toBe("fail");
    // 0.6% in: 1,020 USDC paid, a fail. 0.3% in: about 510, the warning it was before any buys.
    expect((await verdict([{ ...moved([nft(1, l100, T0, HI)]), tick: T0 + 60, sqrtPriceX96: sqrtRatioAtTick(T0 + 60) }], { 1: WALLET })).status).toBe("fail");
    expect((await verdict([{ ...moved([nft(1, l100, T0, HI)]), tick: T0 + 30, sqrtPriceX96: sqrtRatioAtTick(T0 + 30) }], { 1: WALLET })).status).toBe("warn");
  });

  it("the money beside the asks must be within reach too", async () => {
    const deep = T0 - 46_080;
    const far = nft(4, quoteOnlyL(deep - 6_000, deep, 1_200n), deep - 6_000, deep);
    const near = nft(4, quoteOnlyL(T0 - 3_000, T0 - 60, 1_200n), T0 - 3_000, T0 - 60);
    // A wallet's launch, 5,000 burned USDC in range, and the wallet's 1,200 parked out of reach: the tokens alone, a warning.
    expect((await verdict([main([launch(1), twoSided(2, 5_000n), far])], { 1: WALLET, 2: DEAD, 4: WALLET })).status).toBe("warn");
    // With the 1,200 within reach the bids alone still fail nothing (a fifth of what is in reach), and the asks do.
    expect((await verdict([main([launch(1), twoSided(2, 5_000n), near])], { 1: WALLET, 2: DEAD, 4: WALLET })).status).toBe("fail");
  });

  it("bids under 1,000 USDC can't fail or warn: a stranger's parked USDC beside a burned launch, or a wallet's bought-through range", async () => {
    const parked = (usdc: bigint) => nft(4, quoteOnlyL(T0 - 20_000, T0 - 7_020, usdc), T0 - 20_000, T0 - 7_020);
    for (const usdc of [1n, 60n, 999n]) await quiet([main([launch(1), parked(usdc)])], { 1: DEAD, 4: WALLET_2 });
    // The wallet's range, from below the price up to it, has been bought through: it holds 999 USDC and no tokens.
    await quiet([main([nft(1, quoteOnlyL(T0 - 960, T0, 999n), T0 - 960, T0), launch(2)])], { 1: WALLET, 2: DEAD });
    // From 1,000 it is material, and a fail.
    await paidToWallets([main([nft(1, quoteOnlyL(T0 - 960, T0, 1_001n), T0 - 960, T0), launch(2)])], { 1: WALLET, 2: DEAD });
  });

  it("F. a wallet's token range just above the price in a native-USDC pool, beside a burned USDC pool at the same price", async () => {
    // In the native pool the token is currency1 (18-decimal native USDC is currency0): the same $0.001 is tick 69,060 the
    // other way up, and "just above the token's price" is the ticks just below.
    const N0 = 69_060;
    const [a, b] = [sqrtRatioAtTick(N0 - 6_960), sqrtRatioAtTick(N0)];
    const wall = nft(5, (50_000_000n * 10n ** 18n * Q96) / (b - a), N0 - 6_960, N0);
    const f = await verdict([main([twoSided(2, 10_000n)]), { key: v4PoolKey(NATIVE, TOKEN, 3000, 60), tick: N0, sqrtPriceX96: sqrtRatioAtTick(N0), positions: [wall] }], { 2: DEAD, 5: WALLET });
    expect(f).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/5` });
    // The same pool priced beyond the window (the token 4x dearer there: a LOWER tick) takes nothing inside it; its tokens
    // are counted beyond it.
    const far = N0 - 13_860;
    const [c, d] = [sqrtRatioAtTick(far - 6_960), sqrtRatioAtTick(far)];
    const beyond = await verdict([main([twoSided(2, 10_000n)]), { key: v4PoolKey(NATIVE, TOKEN, 3000, 60), tick: far, sqrtPriceX96: sqrtRatioAtTick(far), positions: [nft(5, (50_000_000n * 10n ** 18n * Q96) / (d - c), far - 6_960, far)] }], { 2: DEAD, 5: WALLET });
    expect(beyond.status).toBe("warn");
    expect(beyond.detail).toMatch(/Wallets also hold (49\.9|50)M tokens in positions above twice that price/);
  });

  it("H. a fresh single-sided launch in a wallet, nobody has bought yet: a warning on the tokens alone, and a fail once the wallet holds 1,000 USDC of what buyers paid", async () => {
    const f = await verdict([main([launch(1)])], { 1: WALLET });
    expect(f).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toBe(`In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw and 0% into burned or locked ones. ${ORDER}`);
    // The same launch after buyers have paid 1,400 USDC into it: the price is up, the range holds their money.
    const up = T0 + 2_400;
    const bought = { key: MAIN, tick: up, sqrtPriceX96: sqrtRatioAtTick(up), positions: [launch(1)] };
    const later = await verdict([bought], { 1: WALLET });
    expect(later).toMatchObject({ status: "fail", fixAppId: "vault" });
    expect(later.detail).toMatch(/^Of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw and 0% into burned or locked ones\. Of the [\d,]+ USDC in its pools now, wallets' positions hold [\d,]+ and burned or locked ones 0\./);
  });

  it("the same launch burned: nothing to add, and no pass from here", async () => {
    await quiet([main([launch(1)])], { 1: DEAD });
  });

  it("J. the wallet's range is first in line; burned free tokens later in the window and burned bids don't change who is paid first", async () => {
    const first = nft(1, tokenOnlyL(T0, T0 + 960, 10_000_000n), T0, T0 + 960); // $0.001 to $0.0011: 10,476 USDC
    const late = nft(2, tokenOnlyL(T0 + 6_000, T0 + 6_900, 1_000_000_000n), T0 + 6_000, T0 + 6_900); // 1.82x to 1.99x
    const bids = nft(3, quoteOnlyL(T0 - 6_960, T0 - 60, 1_500n), T0 - 6_960, T0 - 60);
    const f = await verdict([main([first, late, bids])], { 1: WALLET, 2: DEAD, 3: DEAD });
    expect(f).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toMatch(/^In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw and 0% into burned or locked ones\. Of the 1,499 USDC in its pools now, wallets' positions hold 0 and burned or locked ones 1,499\./);
    // The other way round, burned first and the wallet later in the window: buyers do pay the burned range first, and the
    // wallet's share of everything paid by then is what counts.
    await paidToWallets([main([{ ...first, salt: salt(2) }, { ...late, salt: salt(1) }, bids])], { 1: WALLET, 2: DEAD, 3: DEAD });
    const smallLate = nft(1, tokenOnlyL(T0 + 6_000, T0 + 6_900, 100_000n), T0 + 6_000, T0 + 6_900);
    await quiet([main([{ ...first, salt: salt(2) }, smallLate, bids])], { 1: WALLET, 2: DEAD, 3: DEAD });
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
    // Wallets take nothing on the path, so the finding is the line that carries it.
    expect(f.detail).toBe("Of the 4,999 USDC in its pools now, wallets' positions hold 4,999 and burned or locked ones 0. Of that, 4,999 is within reach of sellers, down to half the price: wallets' positions hold 4,999 of it and burned or locked ones 0.");
  });

  it("a wallet's range just above the price, beside a small burned in-range position, doesn't pass", async () => {
    const f = await paidToWallets([main([twoSided(1, 1_500n), nft(2, tokenOnlyL(T0, T0 + 600, 50_000_000n), T0, T0 + 600)])], { 1: DEAD, 2: WALLET });
    expect(f.status).toBe("warn");
    // A small one is a warning, never a pass.
    expect((await verdict([main([twoSided(1, 5_000n), nft(2, tokenOnlyL(T0, T0 + 600, 500_000n), T0, T0 + 600)])], { 1: DEAD, 2: WALLET })).status).toBe("warn");
  });

  describe("a side pool at an absurd price", () => {
    const dust = nft(2, 10n ** 20n, 610_000, 620_000); // 2.2e-12 tokens above tick 600,000, where a raw token is 1e26 raw USDC
    const decoy: PoolSetup = { key: SIDE, sqrtPriceX96: sqrtRatioAtTick(600_000), tick: 600_000, positions: [dust] };
    it("can't pass a wallet-held pool by burning a dust position in it", async () => {
      await paidToWallets([main([twoSided(1, 30_000n)]), decoy], { 1: WALLET, 2: DEAD });
    });
    it("can't fail, or warn, a burned launch by a stranger's dust position in it: it lies far beyond the window, and it is dust", async () => {
      await quiet([main([twoSided(1, 30_000n)]), decoy], { 1: DEAD, 2: WALLET_2 });
    });
  });

  it("a stranger's dust at a near-zero price doesn't move the window or the verdict of a burned launch", async () => {
    // Tick -900,000 is out of range for a pool; -800,000 is 1e-20 of the price. The dust sells 1e-6 of a token on the way up.
    const cheap = -800_000;
    const dust = nft(2, tokenOnlyL(cheap, cheap + 6_000, 1n) / 10n ** 6n, cheap, cheap + 6_000);
    await quiet([main([twoSided(1, 30_000n)]), { key: SIDE, sqrtPriceX96: sqrtRatioAtTick(cheap), tick: cheap, positions: [dust] }], { 1: DEAD, 2: WALLET_2 });
    // A stranger's real asks below the launch price are paid first, as they would be: about 50 USDC of them is a warning.
    const under = nft(2, tokenOnlyL(T0 - 600, T0 - 60, 80_000n), T0 - 600, T0 - 60);
    const side: PoolSetup = { key: SIDE, sqrtPriceX96: sqrtRatioAtTick(T0 - 600), tick: T0 - 600, positions: [under] };
    expect((await verdict([main([twoSided(1, 30_000n)]), side], { 1: DEAD, 2: WALLET_2 })).status).toBe("warn");
    await quiet([main([twoSided(1, 30_000n)]), { ...side, positions: [nft(2, tokenOnlyL(T0 - 600, T0 - 60, 20_000n), T0 - 600, T0 - 60)] }], { 1: DEAD, 2: WALLET_2 });
  });

  describe("a wallet's sell wall in another pool than the burned one", () => {
    const poolA = main([twoSided(1, 5_000n)]);
    const wallet = (tick: number): PoolSetup => ({ key: v4PoolKey(TOKEN, USDC, 10_000, 200), sqrtPriceX96: sqrtRatioAtTick(tick), tick, positions: [nft(2, tokenOnlyL(tick + 200, tick + 3_200, 200_000_000n), tick + 200, tick + 3_200)] });
    const owned = { 1: DEAD, 2: WALLET };
    it("fails with the wall at the burned pool's price, and with it cheaper: buyers are routed to the cheapest tokens first", async () => {
      await paidToWallets([poolA, wallet(T0)], owned);
      // A wall at a quarter of the price is the market: what the burned pool holds up at its own price is out of reach
      // of anyone selling down there, and so is any money beside it. A warning.
      expect((await verdict([poolA, wallet(T0 - 13_800)], owned)).status).toBe("warn");
    });
    it("doesn't pass with the wall anywhere inside the window, and warns with it beyond: its tokens are counted", async () => {
      expect((await verdict([poolA, wallet(T0 + 5_800)], owned)).status).not.toBe("pass");
      const far = await verdict([poolA, wallet(T0 + 20_000)], owned);
      expect(far.status).toBe("warn");
      expect(far.detail).toMatch(/Wallets also hold (199\.9|200)M tokens in positions above twice that price/);
    });
  });
});

describe("tokens wallets sell beyond the window", () => {
  // Burned liquidity from the price to twice it selling 100 million tokens. The window ends at about 2.02x.
  const burnedLaunch = launch(1);
  const wall = (tokens: bigint, from = T0 + 13_020) => nft(2, tokenOnlyL(from, from + 6_000, tokens), from, from + 6_000);

  it("warn from a tenth of all the tokens for sale, counted and never priced", async () => {
    // 12M beyond beside 100M: 10.7%.
    const f = await verdict([main([burnedLaunch, wall(12_000_000n)])], { 1: DEAD, 2: WALLET });
    expect(f).toMatchObject({ status: "warn", fixAppId: "vault", evidenceUrl: `https://explorer.test/token/${PM}/instance/2` });
    expect(f.detail).toMatch(/Wallets also hold (11\.9|12)M tokens in positions above twice that price, which buyers would pay into if the price rises that far\./);
    // 10M beside 100M: 9.1%.
    await quiet([main([burnedLaunch, wall(10_000_000n)])], { 1: DEAD, 2: WALLET });
  });

  it("G1. a holder's 1.1% of the supply parked at 50x to 100x in a new plain pool doesn't warn a burned launch", async () => {
    const parked: PoolSetup = { key: v4PoolKey(TOKEN, USDC, 100, 1), listed: true, sqrtPriceX96: sqrtRatioAtTick(T0), tick: T0, positions: [nft(2, tokenOnlyL(T0 + 39_120, T0 + 46_050, 11_000_000n), T0 + 39_120, T0 + 46_050)] };
    await quiet([main([burnedLaunch]), parked], { 1: DEAD, 2: WALLET_2 });
  });

  it("doesn't depend on the supply, known or not, or on how it was padded", async () => {
    for (const facts of [FACTS, { supply: null, decimals: null }, { supply: 10n ** 30n * 10n ** 18n, decimals: 18 }] as TokenFacts[]) {
      expect((await verdict([main([burnedLaunch, wall(900_000_000n)])], { 1: DEAD, 2: WALLET }, {}, facts)).status).toBe("warn");
      await quiet([main([burnedLaunch, wall(1_000_000n)])], { 1: DEAD, 2: WALLET }, {}, facts);
    }
  });

  it("says nothing of a wall a contract holds, or a burned one: neither is a wallet's", async () => {
    await quiet([main([burnedLaunch, wall(900_000_000n)])], { 1: DEAD, 2: CONTRACT }, { chain: { code: { [CONTRACT]: "0x6080" } } });
    await quiet([main([burnedLaunch, wall(900_000_000n)])], { 1: DEAD, 2: DEAD });
  });
});

describe("one path over every pool, by what a buyer pays; only wallets in plain pools, with money, fail", () => {
  const swapHooked = v4PoolKey(TOKEN, USDC, 100, 60, hookWith("0080"));
  const LAUNCHPAD = v4PoolKey(TOKEN, USDC, 3000, 60, hookWith("2080"));
  const REFUSER = v4PoolKey(TOKEN, USDC, 3000, 60, hookWith("0080"));
  const FEE_99 = v4PoolKey(TOKEN, USDC, 990_000, 60);
  const at = (poolKey: typeof MAIN, tick: number, positions: FakePosition[], lpFee?: number): PoolSetup => ({ key: poolKey, listed: true, sqrtPriceX96: sqrtRatioAtTick(tick), tick, positions, ...(lpFee === undefined ? {} : { lpFee }) });
  const CONDITIONAL = /^In the pools Inspector can read, of the (first )?[\d,]+ USDC buyers (would pay for this token|could pay for the tokens now for sale), [\d.]+% would go into positions wallets can withdraw.* if the hooks and fees of the pools selling it let buyers through\./;
  const PLAIN_WARN = /^In the pools Inspector can read, of the (first )?[\d,]+ USDC buyers (would pay for this token|could pay for the tokens now for sale), [\d.]+% goes into positions wallets can withdraw/;

  describe("a 99% LP fee makes every token there cost a hundred times its pool price", () => {
    it("K1 and K2. a burned wall in a 99%-fee pool below the market doesn't push the wallet's launch out of the window", async () => {
      const D0 = T0 - 9_180; // $0.0004
      const decoy = at(FEE_99, D0, [nft(1, tokenOnlyL(D0, D0 + 1_800, 2_000_000_000n), D0, D0 + 1_800)]);
      const k1 = await paidToWallets([main([launch(2, 100_000_000n)]), decoy], { 1: DEAD, 2: WALLET }, {}, { supply: 10n ** 29n, decimals: 18 });
      expect(k1).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/2` });
      expect(k1.detail).toMatch(/^In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw/);
      expect((await paidToWallets([main([launch(2, 9_900_000n)]), decoy], { 1: DEAD, 2: WALLET })).status).toBe("warn");
    });

    it("K3. the same wall spanning the wallet's range inside the window doesn't water its share down", async () => {
      const wallet = nft(2, tokenOnlyL(T0, T0 + 1_800, 10_000_000n), T0, T0 + 1_800);
      const wall = at(FEE_99, T0 - 5_100, [nft(1, tokenOnlyL(T0 - 5_100, T0 + 1_800, 1_000_000_000n), T0 - 5_100, T0 + 1_800)]);
      const f = await paidToWallets([main([wallet]), wall], { 1: DEAD, 2: WALLET });
      expect(f.detail).toMatch(/^In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 100% goes into positions wallets can withdraw/);
    });

    it("a stranger's asks in a 99%-fee pool just under a burned launch aren't first in line: nothing to add", async () => {
      for (const tokens of [600_000n, 60_000n]) {
        const grief = at(FEE_99, T0 - 120, [nft(2, tokenOnlyL(T0 - 120, T0 - 60, tokens), T0 - 120, T0 - 60)]);
        await quiet([main([launch(1)]), grief], { 1: DEAD, 2: WALLET_2 });
      }
    });

    it("reads a dynamic-fee pool's fee as slot0 has it now, and never counts the pool as plain", async () => {
      // A hook with no swap flag sets the fee: the key says 0x800000, slot0 says 99%.
      const dynamic = v4PoolKey(TOKEN, USDC, 0x800000, 60, hookWith("2000"));
      const grief = at(dynamic, T0 - 120, [nft(2, tokenOnlyL(T0 - 120, T0 - 60, 600_000n), T0 - 120, T0 - 60)], 990_000);
      await quiet([main([launch(1)]), grief], { 1: DEAD, 2: WALLET_2 });
      // At a fee of 0.05% now it is first in line: a warning that says it depends on that pool, and no fail even with money.
      const cheap = await verdict([main([launch(1)]), { ...grief, lpFee: 500 }, MONEY], { 1: DEAD, 2: WALLET_2, ...MONEY_OWNERS });
      expect(cheap.status).toBe("warn");
      // A wallet's launch that lives there alone: the same kind of warning.
      const alone = await verdict([at(dynamic, T0, [launch(1)], 3_000)], { 1: WALLET });
      expect(alone.status).toBe("warn");
      expect(alone.detail).toMatch(CONDITIONAL);
    });
  });

  it("K4. EURC is no dollar: a burned EURC wall nominally just under a wallet's USDC range gives no pass, and a wallet in an EURC pool can't fail", async () => {
    const dex: DexConfig = { quoteTokens: [USD, EUR], v4: UNISWAP_V4 };
    const wallet = nft(2, tokenOnlyL(T0, T0 + 1_380, 100_000_000n), T0, T0 + 1_380);
    const wall: PoolSetup = { key: v4PoolKey(TOKEN, EURC.mainnet, 3000, 60), sqrtPriceX96: sqrtRatioAtTick(T0 - 180), tick: T0 - 180, positions: [nft(1, tokenOnlyL(T0 - 180, T0 + 1_380, 3_000_000_000n), T0 - 180, T0 + 1_380)] };
    const f = await verdict([main([wallet]), wall], { 1: DEAD, 2: WALLET }, { dex });
    expect(f.status).not.toBe("pass");
    expect(f.status).not.toBe("fail");
    // A stranger's wallet asks in an EURC pool, nominally just under a burned USDC launch: a conditional warning at most.
    const stranger: PoolSetup = { ...wall, positions: [nft(2, tokenOnlyL(T0 - 180, T0 - 60, 5_000_000n), T0 - 180, T0 - 60)] };
    const g = await verdict([main([launch(1)]), stranger, MONEY], { 1: DEAD, 2: WALLET_2, ...MONEY_OWNERS }, { dex });
    expect(g.status).toBe("warn");
    expect(g.detail).toMatch(/would go into positions wallets can withdraw .* if the hooks and fees of the pools selling it let buyers through/);
  });

  describe("a pool whose hook runs in swaps", () => {
    it("a wallet's launch there is a conditional warning, burned beside it or not, and never a fail", async () => {
      const f = await verdict([main([launch(1)], swapHooked)], { 1: WALLET });
      expect(f).toMatchObject({ status: "warn", fixAppId: "vault" });
      expect(f.detail).toMatch(CONDITIONAL);
      expect((await verdict([main([twoSided(1, 2_000n), launch(2, 1_000_000n)], swapHooked)], { 1: WALLET, 2: DEAD })).status).toBe("warn");
      expect((await verdict([main([launch(1)], swapHooked), MONEY], { 1: WALLET, ...MONEY_OWNERS })).status).toBe("warn");
      await quiet([main([launch(1)], swapHooked)], { 1: DEAD });
    });

    it("G2. a holder's tokens parked just under the market behind a hook that refuses swaps: a conditional warning on a launch burned behind a swap hook", async () => {
      const parked = at(REFUSER, T0 - 120, [nft(2, tokenOnlyL(T0 - 120, T0 - 60, 600_000n), T0 - 120, T0 - 60)]);
      const f = await verdict([at(LAUNCHPAD, T0, [launch(1)]), parked], { 1: DEAD, 2: WALLET_2 });
      expect(f.status).toBe("warn");
      // The burned launch behind the hook is said as that, not as "burned or locked" and not as nothing.
      expect(f.detail).toBe(
        `In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 59.4% would go into positions wallets can withdraw, 0% into burned or locked ones and 40.6% into burned or locked ones behind a swap hook, a dynamic or high fee, or in a pool not quoted in USDC, if the hooks and fees of the pools selling it let buyers through. ${ORDER}`,
      );
    });

    describe("G3. the same holder adds tokens to a plain pool: still no fail, whatever the amount and the price", () => {
      const g2 = [at(LAUNCHPAD, T0, [launch(1)]), at(REFUSER, T0 - 120, [nft(2, tokenOnlyL(T0 - 120, T0 - 60, 600_000n), T0 - 120, T0 - 60)])];
      const owned = { 1: DEAD, 2: WALLET_2, 3: WALLET_2 };
      const plain = (tick: number, lo: number, hi: number, tokens: bigint): PoolSetup => ({ key: MAIN, tick, sqrtPriceX96: sqrtRatioAtTick(tick), positions: [nft(3, tokenOnlyL(lo, hi, tokens), lo, hi)] });
      it.each([
        ["G3a. 10 tokens about 1000x above the market", plain(T0 + 68_940, T0 + 69_000, T0 + 69_060, 10n)],
        ["G3b. 10 tokens at the market", plain(T0, T0 + 60, T0 + 120, 10n)],
        ["G3d. 2,000 tokens about 1000x above the market: 1,000 USDC on paper", plain(T0 + 68_940, T0 + 69_000, T0 + 69_060, 2_000n)],
        ["G3e. 700,000 tokens at 1.5x to 1.6x in a pool initialised at 1.5x", plain(T0 + 4_020, T0 + 4_080, T0 + 4_680, 700_000n)],
      ])("%s", async (_name, pool) => {
        const f = await verdict([...g2, pool], owned);
        expect(f.status).toBe("warn");
        expect(f.detail).toMatch(CONDITIONAL);
        // Not even with a wallet's 1,200 USDC in a plain pool beside it: the tokens in plain pools are a sliver of the path.
        expect((await verdict([...g2, pool, MONEY], { ...owned, ...MONEY_OWNERS })).status).toBe("warn");
      });
      it("the plain dust alone, without the parked tokens, says nothing", async () => {
        await quiet([g2[0]!, plain(T0 + 68_940, T0 + 69_000, T0 + 69_060, 10n)], { 1: DEAD, 3: WALLET_2 });
      });
    });

    it("a stranger can't fail a plain burned launch with asks behind a hook below its price: a conditional warning", async () => {
      const cheap = T0 - 6_960;
      const behind = at(swapHooked, cheap, [nft(2, tokenOnlyL(cheap, cheap + 3_000, 50_000_000n), cheap, cheap + 3_000)]);
      const f = await verdict([main([launch(1)]), behind, MONEY], { 1: DEAD, 2: WALLET_2, ...MONEY_OWNERS });
      expect(f.status).toBe("warn");
      expect(f.detail).toMatch(CONDITIONAL);
    });

    it("HW. a holder's 60 USDC of tokens just under the market behind a refusing hook doesn't warn a plain burned launch: wallets outside plain pools warn from half", async () => {
      for (const tokens of [60_000n, 40_000n, 400_000n]) {
        const parked = at(REFUSER, T0 - 120, [nft(2, tokenOnlyL(T0 - 120, T0 - 60, tokens), T0 - 120, T0 - 60)]);
        await quiet([main([launch(1)]), parked], { 1: DEAD, 2: WALLET_2 });
      }
      // The same 60 USDC of tokens from a wallet in a plain pool, where buyers do get them: a warning.
      const real: PoolSetup = { key: SIDE, tick: T0 - 120, sqrtPriceX96: sqrtRatioAtTick(T0 - 120), positions: [nft(2, tokenOnlyL(T0 - 120, T0 - 60, 60_000n), T0 - 120, T0 - 60)] };
      expect((await verdict([main([launch(1)]), real], { 1: DEAD, 2: WALLET_2 })).status).toBe("warn");
    });

    it("B1. USDC parked behind a hook that refuses swaps, beside a plain burned launch: a warning that says where the money is", async () => {
      const parked = (usdc: bigint) => at(REFUSER, T0, [nft(2, quoteOnlyL(T0 - 6_000, T0 - 60, usdc), T0 - 6_000, T0 - 60)]);
      const f = await verdict([main([launch(1)]), parked(1_001n)], { 1: DEAD, 2: WALLET_2 });
      expect(f.status).toBe("warn");
      expect(f.detail).toBe(
        "In the pools Inspector can read, of the 1,000 USDC in its pools now, wallets' positions hold 1,000 (1,000 of it behind a swap hook, a dynamic or high fee, or in a pool not quoted in USDC, where nobody may be able to sell into it) and burned or locked ones 0.",
      );
      // However much: bids outside plain pools never fail.
      expect((await verdict([main([twoSided(1, 2_000n)]), parked(500_000n)], { 1: DEAD, 2: WALLET_2 })).status).toBe("warn");
      await quiet([main([launch(1)]), parked(999n)], { 1: DEAD, 2: WALLET_2 });
    });

    it("what dodges: a burned decoy behind a hook under a wallet's plain launch; burned dust in a plain pool doesn't undo a hooked wallet launch's warning", async () => {
      const cheap = T0 - 46_080;
      const decoy = at(swapHooked, cheap, [nft(2, tokenOnlyL(cheap, cheap + 6_960, 100_000_000_000n), cheap, cheap + 6_960)]);
      // The decoy takes the window: the wallet's launch lies beyond it, a thousandth of the tokens for sale.
      await quiet([main([launch(1)]), decoy], { 1: WALLET, 2: DEAD });
      // D1: a wallet's launch behind the launchpad hook, and 10 burned tokens in a plain pool far above.
      const dust: PoolSetup = { key: MAIN, tick: T0 + 68_940, sqrtPriceX96: sqrtRatioAtTick(T0 + 68_940), positions: [nft(3, tokenOnlyL(T0 + 69_000, T0 + 69_060, 10n), T0 + 69_000, T0 + 69_060)] };
      const f = await verdict([at(LAUNCHPAD, T0, [launch(1)]), dust], { 1: WALLET, 3: DEAD });
      expect(f.status).toBe("warn");
      expect(f.detail).toMatch(CONDITIONAL);
    });
  });

  describe("a token whose market isn't on the pools read: what a stranger's new plain pool can do", () => {
    // Nothing else is for sale on the path: the token trades on Uniswap v3, or its own ranges are bought through.
    const v3Market = { ...noPools(everything), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: V3_POOL, [readKey(USDC, "balanceOf", [V3_POOL])]: 50_000n * 10n ** 6n };
    const far = T0 + 68_940;
    const stray = (tokens: bigint): PoolSetup => ({ key: MAIN, tick: far, sqrtPriceX96: sqrtRatioAtTick(far), positions: [nft(3, tokenOnlyL(far + 60, far + 120, tokens), far + 60, far + 120)] });

    it.each([["10 tokens: a thin path, all of it his", 10n], ["2,000 tokens at 1000x the market: 1,000 USDC on paper", 2_000n]])("%s is a warning about the pools read, never a fail", async (_name, tokens) => {
      const f = await verdict([stray(tokens)], { 3: WALLET_2 }, { dex: everything, chain: { reads: v3Market } });
      expect(f.status).toBe("warn");
      expect(f.detail).toMatch(PLAIN_WARN);
      // The same beside a v4 pool whose burned range has been bought through: it holds USDC and sells nothing.
      const boughtThrough = at(v4PoolKey(TOKEN, USDC, 10_000, 200), T0, [nft(1, quoteOnlyL(T0 - 6_000, T0 - 200, 20_000n), T0 - 6_000, T0 - 200)]);
      expect((await verdict([stray(tokens), boughtThrough], { 3: WALLET_2, 1: DEAD })).status).toBe("warn");
    });

    it("to fail it he has to leave 1,000 USDC in a plain pool, and half of all the USDC in the pools", async () => {
      const boughtThrough = at(v4PoolKey(TOKEN, USDC, 10_000, 200), T0, [nft(1, quoteOnlyL(T0 - 6_000, T0 - 200, 20_000n), T0 - 6_000, T0 - 200)]);
      const withBids = (usdc: bigint): PoolSetup => ({ ...stray(2_000n), positions: [...stray(2_000n).positions, nft(4, quoteOnlyL(far - 6_000, far - 60, usdc), far - 6_000, far - 60)] });
      // 1,200 USDC of his beside the tokens: the asks are all his, and he has the money there.
      expect((await verdict([withBids(1_200n), boughtThrough], { 3: WALLET_2, 4: WALLET_2, 1: DEAD })).status).toBe("fail");
      expect((await verdict([withBids(900n), boughtThrough], { 3: WALLET_2, 4: WALLET_2, 1: DEAD })).status).toBe("warn");
    });
  });

  it("counts wallets outside plain pools in a warning's share, and leaves them out of a fail's", async () => {
    // A wallet's launch in a plain pool and as much again in a wallet behind a hook at the same price and fee.
    const sameFee = v4PoolKey(TOKEN, USDC, 3000, 60, hookWith("0080"));
    const f = await verdict([main([launch(1)]), main([launch(2)], sameFee), MONEY], { 1: WALLET, 2: WALLET_2, ...MONEY_OWNERS });
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/^Of the first 1,000 USDC buyers would pay for this token, 50% goes into positions wallets can withdraw and 0% into burned or locked ones\./);
    // With three times as much behind the hook the plain wallet's share is a quarter: a warning, counting both.
    const w = await verdict([main([launch(1)]), main([launch(2, 300_000_000n)], sameFee), MONEY], { 1: WALLET, 2: WALLET_2, ...MONEY_OWNERS });
    expect(w.status).toBe("warn");
    expect(w.detail).toMatch(/^In the pools Inspector can read, of the first 1,000 USDC buyers would pay for this token, 25% goes into positions wallets can withdraw/);
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
    expect((await verdict([pool([asks(1, 100_000_000n)])], { 1: WALLET }, over)).status).toBe("warn");
    await quiet([pool([asks(1, 100_000_000n)])], { 1: DEAD }, over);
    // A wallet's range first in line, a burned one later in the window: J, mirrored.
    const first = asks(1, 10_000_000n, H0, 960);
    const late = asks(2, 1_000_000_000n, H0 - 6_000, 900);
    expect((await verdict([pool([first, late])], { 1: WALLET, 2: DEAD }, over)).status).toBe("warn");
    // A wallet's range beyond the window: counted in tokens.
    const beyond = await verdict([pool([asks(1, 100_000_000n), asks(2, 300_000_000n, H0 - 20_000, 6_000)])], { 1: DEAD, 2: WALLET }, over);
    expect(beyond.status).toBe("warn");
    expect(beyond.detail).toMatch(/Wallets also hold (299\.9|300)M tokens in positions above twice that price/);
  });
});

describe("an index that can't be relied on for a pool adds nothing: the old check answers, never a fail from half a picture", () => {
  // A wallet holds everything that can be read: with the whole picture it would be a fail.
  const held = { chain: owners({ 7: WALLET, 8: WALLET }) };
  const one: PoolSetup[] = [{ key, positions: [nft(7, L)] }];
  it("fails with the whole picture", async () => {
    expect((await check(one, held)).status).toBe("fail");
  });
  it("has no entry for the pool", async () => {
    expect((await silent(one, { ...held, index: { cursor: Number(HEAD), pools: {} } })).status).toBe("unknown");
  });
  it("is truncated", async () => {
    await silent(one, { ...held, index: { cursor: Number(HEAD), pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: true } } } });
  });
  it("lists positions that don't add up to the pool's liquidity: a gap in the index", async () => {
    await silent([{ key, positions: [nft(7, L), nft(8, L)] }], { ...held, index: { cursor: Number(HEAD), pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: false } } } });
  });
  it("names a position that doesn't answer", async () => {
    await silent(one, { chain: { ...held.chain, positionInfoFails: true } });
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

  it("warns on the wallet's share once the index lists the hooked pool, which the burned pool alone would not", async () => {
    const f = await check([{ key, positions: [burned] }, { key: big, positions: [kept], listed: true }], { chain });
    // The wallet's pool has a swap hook: a warning, since a fail needs a plain pool to say it.
    expect(f).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/2` });
    expect(f.detail).toMatch(/Of the 1,507,203 USDC in its pools now, wallets' positions hold 1,477,650 \(1,477,650 of it behind a swap hook, a dynamic or high fee, or in a pool not quoted in USDC, where nobody may be able to sell into it\) and burned or locked ones 29,553\./);
  });

  it("adds nothing when the hooked pool was created after the index's cursor and the lookup doesn't have it", async () => {
    const created: ChainLog = { topics: [INITIALIZE_TOPIC, bigId, topic(TOKEN), topic(USDC)], data: "0x", blockNumber: 950n };
    const index = { cursor: 900, pools: { [id]: { positions: [keyOf(nft(2, 50n * L))], truncated: false } } };
    // The pool that is read is all a wallet's: a fail, but for the pool nobody has read.
    const walletChain: FakeChain = { nftOwners: { 2: WALLET } };
    expect((await check([{ key, positions: [kept] }], { chain: walletChain, index })).status).toBe("fail");
    await silent([{ key, positions: [kept] }], { chain: { ...walletChain, logs: [created] }, index });
  });

  it("ignores a new pool against a currency that isn't a quote: such pools are never counted", async () => {
    const other: ChainLog = { topics: [INITIALIZE_TOPIC, bigId, topic(TOKEN), topic("0x128cC466B61f542da60c70e3aA11c10e19B84EDB")], data: "0x", blockNumber: 950n };
    const index = { cursor: 900, pools: { [id]: { positions: [keyOf(kept)], truncated: false } } };
    expect((await check([{ key, positions: [kept] }], { chain: { ...chain, logs: [other] }, index })).status).toBe("fail");
  });

  describe("a pool list cut short", () => {
    // 50 empty pools the index lists before the real one: discovery reads 50 of the index's pools and stops.
    const decoys = Array.from({ length: MAX_EXTRA_POOLS }, (_, i): PoolSetup => ({ key: v4PoolKey(TOKEN, USDC, 4_000 + i, 60), positions: [], listed: true }));
    const real: PoolSetup = { key: big, positions: [kept], listed: true };
    const small: PoolSetup = { key, positions: [burned] };

    it("is seen: with a 51st pool the index lists, the new path says nothing, where the pools it read would have failed", async () => {
      const { input } = world([{ key, positions: [kept] }, ...decoys, real], { chain });
      const scan = await findPools(input);
      expect(scan.truncated).toBe(true);
      expect(scan.pools.some((p) => p.poolId === bigId)).toBe(false);
      const f = await checkLpLock(input, scan);
      expect(f).toEqual(await checkLpLock({ ...input, v4Positions: undefined }, scan));
      expect(f.status).toBe("unknown");
    });

    it("isn't flagged at exactly 50 listed pools, or for the same pool listed twice", async () => {
      const { input } = world([small, real, ...decoys.slice(1)], { chain });
      const scan = await findPools(input);
      expect(scan.truncated).toBeUndefined();
      expect((await checkLpLock(input, scan)).status).toBe("warn");
      const twice: InspectInput = { ...input, extraPools: [...input.extraPools!, ...input.extraPools!] };
      expect((await findPools(twice)).truncated).toBeUndefined();
    });

    it("is a blocker too when the index's own read was cut short (`extraPoolsTruncated`)", async () => {
      expect((await check([{ key, positions: [kept] }], { chain })).status).toBe("fail");
      await silent([{ key, positions: [kept] }], { chain, input: { extraPoolsTruncated: true } });
    });
  });
});

describe("the inspection's deadline", () => {
  it("leaves lp-lock to the old check when the new path's reads would outlast it, and the rest of the report standing", async () => {
    const { input, reader } = world([{ key, positions: [nft(7, L)] }], { chain: { nftOwners: { 7: DEAD }, code: { [TOKEN]: "0x63a9059cbb00" } } });
    // The position reads never answer.
    const read = reader.read;
    input.reader = { ...reader, read: (address, abi, fn, args, options) => (options?.blockNumber === undefined ? read(address, abi, fn, args, options) : new Promise(() => {})) };
    vi.useFakeTimers();
    try {
      const pending = inspect({ ...input, deadlineAt: Date.now() + 5_000 });
      await vi.advanceTimersByTimeAsync(4_100);
      const report = await pending;
      // The new path gave up; the finding is the old check's.
      expect(report.findings.find((f) => f.id === "lp-lock")).toEqual({
        id: "lp-lock", status: "unknown", title: "Couldn't check liquidity locks",
        detail: "Only Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet.", evidenceUrl: null, fixAppId: null,
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
    expect(await checkLpLock({ ...input, deadlineAt: Date.now() + 500 }, scan)).toMatchObject({ status: "unknown", detail: "Only Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet." });
    expect(reader.batches.length).toBe(before);
    expect(reader.logQueries).toEqual([]);
  });
});

describe("whatever stops the new path, the old check answers: its fail included", () => {
  // The old check fails this token: its v2 LP sits in a wallet. A burned v4 wall beside it, and a fresh index whose
  // tail has to be read.
  const lp = 10n ** 24n;
  const reads = {
    [readKey(V2, "getPair", [TOKEN, USDC])]: PAIR,
    ...v2PairReads(PAIR, USDC, TOKEN, 5_000n * 10n ** 6n, 5_000_000n * 10n ** 18n),
    [readKey(PAIR, "totalSupply", [])]: lp,
    [readKey(PAIR, "balanceOf", [NATIVE])]: 1000n,
    [readKey(PAIR, "balanceOf", [DEAD])]: 0n,
  };
  const dex: DexConfig = { quoteTokens: [USD], v2Factory: V2, v4: UNISWAP_V4 };
  const wall = launch(1);
  const setUp = (chain: FakeChain = {}) => {
    const mainId = v4PoolId(MAIN);
    return world([main([wall])], { dex, chain: { reads, nftOwners: { 1: DEAD }, ...chain }, index: { cursor: Number(HEAD) - 100, pools: { [mainId]: { positions: [keyOf(wall)], truncated: false } } } });
  };
  const OLD = { status: "fail", detail: "100% of the v2 LP supply sits in wallets that can withdraw it.", fixAppId: "vault" };

  it("the control: both run, and the fail stands", async () => {
    const { input } = setUp();
    expect((await checkLpLock(input, await findPools(input), FACTS)).status).toBe("fail");
    expect(await checkLpLock({ ...input, v4Positions: undefined }, await findPools(input), FACTS)).toMatchObject(OLD);
  });

  it("the inspection's deadline has passed by the time lp-lock starts", async () => {
    const { input } = setUp();
    expect(await checkLpLock({ ...input, deadlineAt: Date.now() }, await findPools(input), FACTS)).toMatchObject(OLD);
  });

  it("the node refuses the index tail's eth_getLogs, as Arc does past 20,000 results", async () => {
    const { input } = setUp({ logs: Object.assign(new Error("query exceeds max results 20000"), { code: -32012 }) });
    expect(await checkLpLock(input, await findPools(input), FACTS)).toMatchObject(OLD);
  });

  it("the old check isn't held to the new path's deadline: it starts first, and is waited for", async () => {
    const { input, reader } = setUp();
    // The pair's LP reads answer only after the new path's deadline has passed.
    const read = reader.read;
    input.reader = { ...reader, read: (address, abi, fn, args, options) => (address === PAIR && fn === "balanceOf" ? new Promise((resolve) => setTimeout(resolve, 150)).then(() => read(address, abi, fn, args, options)) : read(address, abi, fn, args, options)) };
    expect(await checkLpLock({ ...input, deadlineAt: Date.now() + 1_050 }, await findPools(input), FACTS)).toMatchObject(OLD);
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
    const walletV4 = await both([twoSided(7, 2_000n)], pair(100n, 2_000n), { 7: WALLET });
    expect(walletV4).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/7` });
    expect(walletV4.detail).toMatch(/Of the 3,999 USDC in its pools now, wallets' positions hold 1,999 and burned or locked ones 2,000\./);
    const walletLp = await both([twoSided(7, 2_000n)], pair(0n, 2_000n), { 7: DEAD });
    expect(walletLp).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PAIR}?tab=holders` });
  });

  it("a burned v2 pair beside a burned v4 pool: nothing to add, and the old check's answer is no pass", async () => {
    const f = await silent([main([twoSided(7, 2_000n)])], { dex: everything, chain: { reads: pair(100n, 2_000n), nftOwners: { 7: DEAD } } });
    expect(f).toMatchObject({ status: "unknown", detail: "A Uniswap v4 pool that may hold more than this v2 pair sits beside it, and positions in it can't be read without an index yet." });
  });

  it("splits a v2 pair by LP holder; LP in a known locker or an unvetted one is nobody's wallet", async () => {
    // 20% of the pair's LP in wallets is a tenth of what buyers pay: a warning here, and a fail in the old check, which wins.
    expect(await both([twoSided(7, 2_000n)], pair(80n, 2_000n), { 7: DEAD })).toMatchObject({ status: "fail", detail: "20% of the v2 LP supply sits in wallets that can withdraw it." });
    // A wallet's v4 position of that size beside a burned pair: the old check can't see it, and the warning stands.
    expect((await both([twoSided(7, 1_800n), twoSided(8, 400n)], pair(100n, 1_800n), { 7: DEAD, 8: WALLET })).status).toBe("warn");
    await silent([main([twoSided(7, 2_000n)])], { dex: everything, chain: { reads: { ...pair(50n, 2_000n), [readKey(PAIR, "balanceOf", [LOCKER])]: 50n }, nftOwners: { 7: DEAD } }, input: { knownLockers: [LOCKER] } });
    await silent([main([twoSided(7, 2_000n)])], { dex: everything, chain: { reads: pair(10n, 2_000n), nftOwners: { 7: DEAD } }, input: { lockersVetted: false } });
  });

  it("a v2 pair sells all the way up, from 0.3% over its price: it alone reaches the window however thin its start", async () => {
    // 600 USDC in a burned pair: buyers have paid 1,000 into it by the time the price is 7.1 times higher.
    const { input } = world([{ key: MAIN, tick: T0, sqrtPriceX96: sqrtRatioAtTick(T0), positions: [] }], { dex: everything, chain: { reads: pair(100n, 600n) }, input: { extraPoolsTruncated: undefined } });
    const tally = (await tallyLiquidity({ ...input, extraPools: [{ version: "v4", key: MAIN }] }, await findPools(input), everything))!;
    expect(tally.path).toMatchObject({ reached: true });
    expect(tally.path!.prefixes[0]!.burned / SHARE_SCALE).toBeGreaterThanOrEqual(999_999_999n);
    expect(tally.bids.burned).toBe(600_000_000n * SHARE_SCALE);
  });

  it("V3-2. a v3 pool's positions aren't read, so nothing of it is a wallet's and nothing of it makes a pass: beside a burned v4 wall the old check answers", async () => {
    // A v3 pool holding no USDC and 9.99M tokens, a wallet's range just under the wall for all anyone here can tell.
    for (const tokens of [9_990_000n, 10_100_000n, 100_000n]) {
      const f = await silent([main([launch(1)])], { dex: everything, chain: { reads: { ...noPools(everything), ...v3(0n, tokens) }, nftOwners: { 1: DEAD } } });
      expect(f.status).toBe("unknown");
    }
  });

  it("a v3 pool's USDC is nobody's in particular: it makes a wallet's share of the USDC in the pools smaller", async () => {
    // A wallet's bought-through v4 range holding 2,000 USDC, a burned launch above it, a v3 pool holding 2,100.
    const bought = nft(7, quoteOnlyL(T0 - 960, T0, 2_000n), T0 - 960, T0);
    const reads = (usdc: bigint) => ({ ...noPools(everything), ...v3(usdc, 1n) });
    expect((await both([bought, launch(1)], reads(1_000n), { 7: WALLET, 1: DEAD })).status).toBe("fail");
    const f = await both([bought, launch(1)], reads(2_100n), { 7: WALLET, 1: DEAD });
    expect(f.status).toBe("warn");
    expect(f.detail).toMatch(/of the 4,099 USDC in its pools now, wallets' positions hold 1,999 and burned or locked ones 0\./);
  });

  it("adds nothing while a family of pools never answered", async () => {
    await silent([], { dex: everything, chain: { reads: pair(0n, 5_000n), multicallReverts: true }, input: { extraPoolsTruncated: true } });
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

  it("a v2-only token whose tail shows a new v4 pool nobody has read: the new path says nothing, and the old check answers as today", async () => {
    const created: ChainLog = { topics: [INITIALIZE_TOPIC, `0x${"c1".repeat(32)}`, topic(TOKEN), topic(USDC)], data: "0x", blockNumber: 950n };
    const f = await silent([], { dex: v2AndV4, chain: { reads: pairReads(100n), logs: [created] }, index: { cursor: 900, pools: {} } });
    expect(f).toMatchObject({ status: "pass", detail: "100% of the v2 LP supply can't be withdrawn." });
  });

  it("a wallet's v4 position beside a burned v2 pair: the old check says unknown, the new path says fail", async () => {
    const reads = { ...pairReads(100n), ...v2PairReads(PAIR, USDC, TOKEN, 5_000n * 10n ** 6n, 5_000n * 10n ** 21n) };
    const { input } = world([main([twoSided(7, 20_000n)])], { dex: v2AndV4, chain: { reads, nftOwners: { 7: WALLET } } });
    const scan = await findPools(input);
    expect((await checkLpLock(without(input), scan)).status).toBe("unknown");
    expect(await checkLpLock(input, scan)).toMatchObject({ status: "fail", fixAppId: "vault" });
  });

  it("a warning from the new path gives way to the old check's fail", async () => {
    // 90% of the v2 LP in wallets: the old check fails. A burned v4 range eight times deeper at the same price makes
    // that a tenth of what buyers pay, which alone would be a warning.
    const reads = { ...pairReads(10n), ...v2PairReads(PAIR, USDC, TOKEN, 5_000n * 10n ** 6n, 5_000n * 10n ** 21n) };
    const { input } = world([main([twoSided(7, 40_000n)])], { dex: v2AndV4, chain: { reads, nftOwners: { 7: DEAD } } });
    const scan = await findPools(input);
    const before = await checkLpLock(without(input), scan);
    expect(before).toMatchObject({ status: "fail", detail: "90% of the v2 LP supply sits in wallets that can withdraw it." });
    expect(await checkLpLock(input, scan)).toEqual(before);
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
