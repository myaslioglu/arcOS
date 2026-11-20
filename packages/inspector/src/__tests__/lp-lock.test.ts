import { describe, expect, it, vi } from "vitest";
import { AERODROME, EURC, UNISWAP_V4, USDC, type DexConfig } from "@arcos/chain";
import { SHARE_SCALE, checkLpLock, findPools, tallyLiquidity } from "../checks";
import { inspect } from "../inspect";
import type { ChainLog, ExtraPool, Finding, InspectInput, V4PositionIndex, V4PositionKey } from "../types";
import { MAX_EXTRA_POOLS, NATIVE, sqrtRatioAtTick, v4PoolId, v4PoolKey } from "../v4";
import { HEAD_MARGIN, INITIALIZE_TOPIC, MODIFY_LIQUIDITY_TOPIC, positionQuote } from "../v4-positions";
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
const COUNTED = "Measured two ways, the stricter one shown: by the USDC in this token's pools now, and by that plus what buyers would pay into its pools before its price reaches twice what it is in the main pool.";

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
/** A position of 10^12 over [-600, 600] at price 1 holds 29,553.010879 USDC now, and buyers pay as much again into it before the price doubles. */
const held = (liquidity: bigint) => positionQuote({ sqrtPriceX96: Q96, tickLower: -600, tickUpper: 600, liquidity, quoteIsCurrency0: false });

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

describe("lp-lock over a Uniswap v4 pool's positions", () => {
  it("fails when a wallet holds the position: the share, the USDC it holds now, a Vault fix and the NFT's page", async () => {
    const f = await lpLock([nft(7, L)], { chain: owners({ 7: WALLET }) });
    expect(f).toEqual({
      id: "lp-lock",
      status: "fail",
      title: "Liquidity isn't locked",
      detail: `100% of this token's liquidity is in positions wallets can withdraw, which hold 29,553 USDC now; 0% is burned or locked. ${COUNTED}`,
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: "vault",
    });
  });

  it("passes when the NFT sits at a burn address", async () => {
    const f = await lpLock([nft(7, L)], { chain: owners({ 7: DEAD }) });
    expect(f).toEqual({
      id: "lp-lock",
      status: "pass",
      title: "Liquidity is burned or locked",
      detail: `100% of this token's liquidity is burned or locked (burned: 100%, locked: 0%), over 1 pool(s) holding 29,553 USDC now. ${COUNTED}`,
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: null,
    });
  });

  it("passes when a known locker holds it, and says which share is locked", async () => {
    const f = await lpLock([nft(1, 3n * L), nft(2, L)], { chain: owners({ 1: LOCKER, 2: NATIVE }), input: { knownLockers: [LOCKER] } });
    expect(f).toMatchObject({ status: "pass", detail: expect.stringContaining("100% of this token's liquidity is burned or locked (burned: 25%, locked: 75%)") as string });
  });

  it("is unknown, never a fail, when a contract holds it: the contract may be a locker", async () => {
    const f = await lpLock([nft(7, L)], { chain: { ...owners({ 7: CONTRACT }), code: { [CONTRACT]: "0x6080" } } });
    expect(f).toMatchObject({
      status: "unknown",
      title: "Couldn't check liquidity locks",
      detail: `Of this token's liquidity, 100% is held by contracts whose lock terms can't be read. Burned or locked needs 95% to pass. ${COUNTED}`,
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: null,
    });
  });

  it("classifies a position held straight in the PoolManager by its sender: a contract, linked by its address", async () => {
    const own: FakePosition = { owner: SENDER, tickLower: -600, tickUpper: 600, salt: salt(0), liquidity: L };
    const f = await lpLock([own], { chain: { code: { [SENDER]: "0x6080" } } });
    expect(f).toMatchObject({ status: "unknown", evidenceUrl: `https://explorer.test/address/${SENDER}` });
    expect(f.detail).toMatch(/100% is held by contracts whose lock terms can't be read/);
  });

  it("counts an EIP-7702 wallet as a wallet", async () => {
    const f = await lpLock([nft(7, L)], { chain: { ...owners({ 7: WALLET }), code: { [WALLET]: `0xef0100${"ab".repeat(20)}` } } });
    expect(f.status).toBe("fail");
  });

  describe("the lines: fail from 50% in wallets, pass from 95% safe, warn above 5% in wallets", () => {
    // Every position over the same range, so both measures give the same shares.
    const split = (burned: bigint, wallet: bigint, contract = 0n) =>
      lpLock([nft(1, burned * L), nft(2, wallet * L), ...(contract > 0n ? [nft(3, contract * L)] : [])], {
        chain: { ...owners({ 1: DEAD, 2: WALLET, 3: CONTRACT }), code: { [CONTRACT]: "0x6080" } },
      });
    it("passes at exactly 95% burned with 5% in a wallet", async () => {
      expect(await split(95n, 5n)).toMatchObject({ status: "pass", fixAppId: null, detail: expect.stringMatching(/^95% of this token's liquidity is burned or locked/) as string });
    });
    it("warns just past 5% in wallets, with the Vault fix and what they hold", async () => {
      expect(await split(94n, 6n)).toMatchObject({
        status: "warn",
        title: "Some liquidity isn't locked",
        fixAppId: "vault",
        detail: `6% of this token's liquidity is in positions wallets can withdraw, which hold 177,318 USDC now; 94% is burned or locked. ${COUNTED}`,
        evidenceUrl: `https://explorer.test/token/${PM}/instance/2`,
      });
    });
    it("warns just under half in wallets, and fails at exactly half", async () => {
      expect((await split(51n, 49n)).status).toBe("warn");
      expect(await split(50n, 50n)).toMatchObject({ status: "fail", title: "Liquidity isn't locked", fixAppId: "vault" });
      expect((await split(10n, 50n, 40n)).status).toBe("fail");
    });
    it("is unknown when too little is safe to pass and too little is in wallets to warn", async () => {
      expect(await split(90n, 5n, 5n)).toMatchObject({
        status: "unknown",
        fixAppId: null,
        detail: `Of this token's liquidity, 5% is held by contracts whose lock terms can't be read; 5% is in positions wallets can withdraw; 90% is burned or locked. Burned or locked needs 95% to pass. ${COUNTED}`,
      });
    });
    it("warns on a third party's 10% whoever holds the rest", async () => {
      expect((await split(0n, 10n, 90n)).status).toBe("warn");
    });
  });

  it("links the largest position that isn't safe", async () => {
    const f = await lpLock([nft(1, 2n * L), nft(2, 5n * L), nft(3, 90n * L)], { chain: owners({ 1: WALLET, 2: WALLET_2, 3: DEAD }) });
    expect(f).toMatchObject({ status: "warn", evidenceUrl: `https://explorer.test/token/${PM}/instance/2` });
  });

  it("drops positions that hold nothing, and can't judge pools that hold no USDC", async () => {
    expect(await lpLock([nft(1, 0n), nft(2, L)], { chain: owners({ 2: DEAD }) })).toMatchObject({ status: "pass" });
    const none = { status: "unknown", detail: "This token's pools hold no USDC now, so there is no liquidity to judge.", fixAppId: null };
    expect(await lpLock([nft(1, 0n)], { chain: owners({ 1: WALLET }) })).toMatchObject(none);
    // A launch pool that holds only tokens so far: nothing to pull, nothing locked.
    expect(await lpLock([nft(1, L, 600, 1200)], { chain: owners({ 1: DEAD }) })).toMatchObject(none);
    expect(await lpLock([nft(1, L, 600, 1200)], { chain: owners({ 1: WALLET }) })).toMatchObject(none);
  });

  it("doesn't pass on burned liquidity under 1,000 USDC: too little to call locked", async () => {
    // 10^10 of liquidity holds 295 USDC.
    const f = await lpLock([nft(7, L / 100n)], { chain: owners({ 7: DEAD }) });
    expect(f).toMatchObject({
      status: "unknown",
      detail: `100% of this token's liquidity is burned or locked, but its pools hold under 1,000 USDC: too little to call locked liquidity. ${COUNTED}`,
      fixAppId: null,
    });
    // 34 × 10^9 holds 1,004 USDC.
    expect((await lpLock([nft(7, 34n * 10n ** 9n)], { chain: owners({ 7: DEAD }) })).status).toBe("pass");
  });

  describe("a hook that runs when liquidity is removed", () => {
    const hooked = (flags: string) => ({ poolKey: v4PoolKey(TOKEN, USDC, 10_000, 200, hookWith(flags)), listed: true });
    it.each([["BEFORE_REMOVE_LIQUIDITY", "0200"], ["AFTER_REMOVE_LIQUIDITY", "0100"], ["AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA", "0001"]])("makes a wallet's position unknown: %s", async (_name, flags) => {
      const f = await lpLock([nft(7, L)], { ...hooked(flags), chain: owners({ 7: WALLET }) });
      expect(f).toMatchObject({
        status: "unknown",
        detail: `Of this token's liquidity, 100% is in wallets' positions in a pool whose hook runs when liquidity is removed, so it can block or tax a withdrawal. Burned or locked needs 95% to pass. ${COUNTED}`,
        fixAppId: null,
      });
    });
    it("leaves a burned position burned", async () => {
      expect((await lpLock([nft(7, L)], { ...hooked("0200"), chain: owners({ 7: DEAD }) })).status).toBe("pass");
    });
    it("changes nothing when the hook has no remove-liquidity permission", async () => {
      expect((await lpLock([nft(7, L)], { ...hooked("00c0"), chain: owners({ 7: WALLET }) })).status).toBe("fail");
    });
  });

  it("leaves the classifying of many small holders out rather than read code for all of them", async () => {
    // 60 wallets with 1% each and one burned position of 40%: the 40 largest wallets are read, the other 20 aren't.
    const positions = [nft(1_000, 40n * L), ...Array.from({ length: 60 }, (_, i) => nft(i + 1, L))];
    const nftOwners = Object.fromEntries([[1_000, DEAD], ...positions.slice(1).map((_, i) => [i + 1, `0x${(0xb0b000 + i).toString(16).padStart(40, "0")}`])]) as Record<number, string>;
    const { input, reader } = world([{ key, positions }], { chain: { nftOwners } });
    let codeReads = 0;
    input.reader = { ...reader, getCode: (a) => (codeReads++, reader.getCode(a)) };
    const tally = (await tallyLiquidity(input, await findPools(input), v4Only))!;
    expect(codeReads).toBe(40);
    expect(tally.now.withdrawable).toBe(40n * held(L).now * SHARE_SCALE);
    expect(tally.now.unknown.unclassified).toBe(20n * held(L).now * SHARE_SCALE);
    expect(tally.ahead.withdrawable).toBe(40n * (held(L).now + held(L).inflow) * SHARE_SCALE);
    expect((await checkLpLock(input, await findPools(input))).status).toBe("warn");
  });
});

describe("what is counted: the quote currency, never a token amount at a pool's price", () => {
  it("launch: a wallet keeps the in-range position with all the USDC, and a 980M-token range far above the price is burned", async () => {
    // $0.001 a token: 1e-15 raw USDC per raw token, tick -345,405; spacing 60.
    const tick = -345_420;
    const sqrtP = sqrtRatioAtTick(tick) + 1n;
    const poolKey = v4PoolKey(TOKEN, USDC, 3000, 60);
    // The deployer's in-range position, sized to hold 10,000 USDC.
    const [rLo, rHi] = [tick - 6_000, tick + 6_000];
    const inRange = (10_000n * 10n ** 6n * Q96) / (sqrtP - sqrtRatioAtTick(rLo));
    // A burned token-only position from about 50x to about 1000x the price, sized to hold 980M tokens (18 decimals).
    const [bLo, bHi] = [tick + 39_120, tick + 69_060];
    const [sa, sb] = [sqrtRatioAtTick(bLo), sqrtRatioAtTick(bHi)];
    const wall = (980_000_000n * 10n ** 18n * sa * sb) / (Q96 * (sb - sa));
    const f = await check([{ key: poolKey, sqrtPriceX96: sqrtP, tick, positions: [nft(1, inRange, rLo, rHi), nft(2, wall, bLo, bHi)] }], { chain: owners({ 1: WALLET, 2: DEAD }) });
    expect(f).toMatchObject({ status: "fail", title: "Liquidity isn't locked", evidenceUrl: `https://explorer.test/token/${PM}/instance/1` });
    expect(f.detail).toMatch(/^100% of this token's liquidity is in positions wallets can withdraw, which hold 9,999 USDC now; 0% is burned or locked\./);
  });

  it("the same with the burned token wall right above the price: free tokens within reach of the price don't outvote the money", async () => {
    // The wall's inflow is tokens times the price, as large as its burner likes: in the look-ahead measure the burned share
    // is nearly everything. The wallet still holds every USDC in the pool, which the measure of what is there now says.
    const wall = nft(2, 10_000n * L, 0, 6_900);
    const { input } = world([{ key, positions: [nft(1, L, -600, 0), wall] }], { chain: owners({ 1: WALLET, 2: DEAD }) });
    const scan = await findPools(input);
    const tally = (await tallyLiquidity(input, scan, v4Only))!;
    expect(tally.ahead.burned).toBeGreaterThan(100n * tally.ahead.withdrawable);
    expect(tally.now).toMatchObject({ burned: 0n, withdrawable: held(L).now * SHARE_SCALE });
    expect(await checkLpLock(input, scan)).toMatchObject({ status: "fail", detail: expect.stringMatching(/^100% of this token's liquidity is in positions wallets can withdraw/) as string });
  });

  it("a wallet's range just above the price, beside a small burned in-range position, doesn't pass", async () => {
    // The burned position holds all the USDC there is now (1,477 USDC); the wallet's range holds none, and takes most of what
    // buyers pay next.
    const f = await lpLock([nft(1, L / 20n), nft(2, 100n * L, 0, 600)], { chain: owners({ 1: DEAD, 2: WALLET }) });
    expect(f.status).toBe("fail");
    expect(f.detail).toMatch(/of this token's liquidity is in positions wallets can withdraw, which hold 0 USDC now/);
    // A smaller one is a warning, never a pass.
    expect((await lpLock([nft(1, L), nft(2, L / 5n, 0, 600)], { chain: owners({ 1: DEAD, 2: WALLET }) })).status).toBe("warn");
    // Out of the price's reach before it doubles (tick 6,932), it takes nothing in that time: the burned position passes.
    expect((await lpLock([nft(1, L), nft(2, 100n * L, 7_000, 7_600)], { chain: owners({ 1: DEAD, 2: WALLET }) })).status).toBe("pass");
  });

  describe("a side pool at an absurd price", () => {
    const realKey = v4PoolKey(TOKEN, USDC, 3000, 60);
    // T/USDC 0.05% (a standard tier, so discovery probes it), initialised at tick 600,000: one raw token is 1e26 raw USDC.
    const decoy = (positions: FakePosition[]): PoolSetup => ({ key, sqrtPriceX96: sqrtRatioAtTick(600_000), tick: 600_000, positions });
    const dust = nft(2, 10n ** 20n, 610_000, 620_000); // 2.2e-12 tokens, no USDC

    it("can't pass a wallet-held pool by burning a dust position in it", async () => {
      const f = await check([{ key: realKey, positions: [nft(1, 1_000n * L)] }, decoy([dust])], { chain: owners({ 1: WALLET, 2: DEAD }) });
      expect(f).toMatchObject({ status: "fail", detail: expect.stringMatching(/^100% of this token's liquidity is in positions wallets can withdraw, which hold 29,553,010 USDC now/) as string });
    });

    it("can't fail a burned launch by a stranger's dust position in it", async () => {
      const f = await check([{ key: realKey, positions: [nft(1, 1_000n * L)] }, decoy([dust])], { chain: owners({ 1: DEAD, 2: WALLET_2 }) });
      expect(f).toMatchObject({ status: "pass", detail: expect.stringContaining("100% of this token's liquidity is burned or locked (burned: 100%, locked: 0%), over 2 pool(s) holding 29,553,010 USDC now.") as string });
    });

    it("counts nothing for it right above that price either: an inflow is the reference pool's alone", async () => {
      // Token-only and within reach of the absurd price doubling: buyers would pay astronomic sums into it "before the price
      // doubles", at a price nobody trades at. Only the pool most of the money is in has an inflow.
      const near = nft(2, 10n ** 20n, 600_010, 606_000);
      expect(positionQuote({ sqrtPriceX96: sqrtRatioAtTick(600_000), tickLower: 600_010, tickUpper: 606_000, liquidity: 10n ** 20n, quoteIsCurrency0: false })).toMatchObject({ now: 0n, inflow: expect.any(BigInt) as bigint });
      const { input } = world([{ key: realKey, positions: [nft(1, 1_000n * L)] }, decoy([near])], { chain: owners({ 1: DEAD, 2: WALLET_2 }) });
      const scan = await findPools(input);
      const tally = (await tallyLiquidity(input, scan, v4Only))!;
      expect(tally.ahead.withdrawable).toBe(tally.now.withdrawable);
      expect((await checkLpLock(input, scan)).status).toBe("pass");
    });
  });

  describe("a wallet's sell wall in another pool than the one the money is in", () => {
    // Pool A: 1,000 × 10^9 of burned liquidity in range, 29,553 USDC: the reference. Pool B: a wallet's, a little USDC in
    // range and deep token liquidity just above its price. Buyers are routed to the cheaper pool first, so B takes their
    // money before A does.
    const poolA: PoolSetup = { key: v4PoolKey(TOKEN, USDC, 3000, 60), positions: [nft(1, L)] };
    const keyB = v4PoolKey(TOKEN, USDC, 10_000, 200);
    const owned = { chain: owners({ 1: DEAD, 2: WALLET, 3: WALLET }) };
    /** Pool B at `tick`: 40-odd USDC in range (10^9.. liquidity is 1/750 of A's) and a deep wall from its price up 3,000 ticks. */
    const poolB = (tick: number): PoolSetup => ({
      key: keyB,
      sqrtPriceX96: sqrtRatioAtTick(tick),
      tick,
      positions: [nft(2, L / 750n, tick - 600, tick + 600), nft(3, 50n * L, tick + 200, tick + 3_200)],
    });

    it("doesn't pass with B at A's price, though the wallet holds 0.1% of the USDC now", async () => {
      const { input } = world([poolA, poolB(0)], owned);
      const scan = await findPools(input);
      const tally = (await tallyLiquidity(input, scan, v4Only))!;
      expect(tally.now.withdrawable * 100n).toBeLessThan(tally.now.burned);
      expect(tally.ahead.withdrawable).toBeGreaterThan(tally.ahead.burned);
      const f = await checkLpLock(input, scan);
      expect(f.status).toBe("fail");
      expect(f.detail).toMatch(/which hold 39 USDC now/);
    });

    it("doesn't pass with B cheaper than A: it is looked ahead to twice A's price, not twice its own", async () => {
      // B at a quarter of A's price (tick -13,863): its wall, from there up, is all below twice A's price.
      const f = await check([poolA, poolB(-13_800)], owned);
      expect(f.status).toBe("fail");
    });

    it("doesn't pass with B priced anywhere up to twice A's, and takes nothing from a B priced beyond that", async () => {
      // 1.8x (tick 5,878): the start of the wall is within reach.
      expect((await check([poolA, poolB(5_800)], owned)).status).not.toBe("pass");
      // 2.2x (tick 7,885): past the target, B counts for the USDC it holds now and nothing more.
      const { input } = world([poolA, poolB(8_000)], owned);
      const scan = await findPools(input);
      const tally = (await tallyLiquidity(input, scan, v4Only))!;
      expect(tally.ahead.withdrawable).toBe(tally.now.withdrawable);
      expect((await checkLpLock(input, scan)).status).toBe("pass");
    });

    it("works the same with the token as currency1 in the other pool: a native-USDC pool, the other orientation and 18 decimals", async () => {
      // Pool A as before (token currency0, USDC with 6 decimals as currency1). Pool B against native USDC (address 0, 18
      // decimals), where the token is currency1: the same market price is raw price 1e-12 the other way up, tick -276,325,
      // and "above the token's price" is BELOW that tick.
      const native = v4PoolKey(NATIVE, TOKEN, 10_000, 200);
      const tick = -276_400;
      const wall = nft(3, 10n ** 6n * 50n * L, tick - 3_200, tick - 200);
      const inRange = nft(2, (10n ** 6n * L) / 750n, tick - 600, tick + 600);
      const { input } = world([poolA, { key: native, sqrtPriceX96: sqrtRatioAtTick(tick), tick, positions: [inRange, wall] }], owned);
      const scan = await findPools(input);
      const tally = (await tallyLiquidity(input, scan, v4Only))!;
      expect(tally.now.withdrawable * 100n).toBeLessThan(tally.now.burned);
      expect(tally.ahead.withdrawable).toBeGreaterThan(tally.ahead.burned);
      expect((await checkLpLock(input, scan)).status).toBe("fail");
      // And priced beyond twice A's price (the token dearer: a LOWER tick here), it takes nothing.
      const far = -276_400 - 8_000;
      const beyond = world([poolA, { key: native, sqrtPriceX96: sqrtRatioAtTick(far), tick: far, positions: [nft(3, 10n ** 6n * 50n * L, far - 3_200, far - 200)] }], owned);
      const t2 = (await tallyLiquidity(beyond.input, await findPools(beyond.input), v4Only))!;
      expect(t2.ahead.withdrawable).toBe(0n);
    });

    it("a stranger's dust in a pool at a near-zero price beside a burned launch still passes", async () => {
      // Tick -600,000: the token at 1e-26 of a raw USDC. The dust is 2.2e-12 tokens' worth of liquidity above that price;
      // bought all the way up to twice the real price it is still dust.
      const dust = nft(2, 10n ** 6n, -599_000, 0);
      const f = await check([{ key: v4PoolKey(TOKEN, USDC, 3000, 60), positions: [nft(1, 1_000n * L)] }, { key, sqrtPriceX96: sqrtRatioAtTick(-600_000), tick: -600_000, positions: [dust] }], { chain: owners({ 1: DEAD, 2: WALLET_2 }) });
      expect(f.status).toBe("pass");
    });
  });

  it("has no look-ahead, and so no pass, when the pool holding the most quote is one whose price isn't read", async () => {
    const reads = { ...noPools(everything), [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: V3_POOL, [readKey(USDC, "balanceOf", [V3_POOL])]: 40_000_000_000n };
    const { input } = world([{ key, positions: [nft(1, L)] }], { dex: everything, chain: { reads, nftOwners: { 1: DEAD } } });
    const tally = (await tallyLiquidity(input, await findPools(input), everything))!;
    expect(tally.lookAhead).toBe(false);
    expect(tally.ahead).toEqual(tally.now);
  });

  it("a burned decoy holding more USDC than the real pool doesn't pass under 1,000 USDC", async () => {
    // Real pool: 295 USDC in a wallet. Decoy: 591 USDC burned. One third is withdrawable: a warning.
    const realKey = v4PoolKey(TOKEN, USDC, 3000, 60);
    const f = await check([{ key: realKey, positions: [nft(1, L / 100n)] }, { key, positions: [nft(2, L / 50n)] }], { chain: owners({ 1: WALLET, 2: DEAD }) });
    expect(f.status).toBe("warn");
    // With the wallet's part tiny, what is left is burned, and still too little to pass.
    const tiny = await check([{ key: realKey, positions: [nft(1, L / 10_000n)] }, { key, positions: [nft(2, L / 50n)] }], { chain: owners({ 1: WALLET, 2: DEAD }) });
    expect(tiny).toMatchObject({ status: "unknown", detail: expect.stringContaining("but its pools hold under 1,000 USDC") as string });
  });

  it("looks ahead the right way when the token is currency1: its price doubling is the raw price halving", async () => {
    const highKey = v4PoolKey(HIGH, USDC, 500, 10);
    const over = { token: HIGH as `0x${string}` };
    // For this pair a range BELOW tick 0 is above the token's price: it holds only tokens, and takes the buyers' USDC.
    const above = await check([{ key: highKey, positions: [nft(1, L / 20n), nft(2, 100n * L, -600, 0)] }], { ...over, chain: owners({ 1: DEAD, 2: WALLET }) });
    expect(above.status).toBe("fail");
    expect(above.detail).toMatch(/which hold 0 USDC now/);
    // A range above tick 0 is a bid below the token's price: it holds USDC now, and nothing more comes to it as the price rises.
    const { input } = world([{ key: highKey, positions: [nft(1, L), nft(2, L, 0, 600)] }], { ...over, chain: owners({ 1: DEAD, 2: WALLET }) });
    const tally = (await tallyLiquidity(input, await findPools(input), v4Only))!;
    expect(tally.now.withdrawable).toBeGreaterThan(0n);
    expect(tally.ahead.withdrawable).toBe(tally.now.withdrawable);
    expect(tally.ahead.burned).toBeGreaterThan(tally.now.burned);
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
    expect(f.detail).toMatch(/^98% of this token's liquidity is in positions wallets can withdraw, which hold 1,477,650 USDC now; 2% is burned or locked\./);
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
  /** A v2 pair at the v4 pool's price (one raw unit of quote a raw token) unless told. */
  const pair = (lpBurned: bigint, quoteReserve: bigint, quote = USDC, tokenReserve = quoteReserve) => ({
    ...noPools(everything),
    [readKey(V2, "getPair", [TOKEN, quote])]: PAIR,
    ...v2PairReads(PAIR, quote, TOKEN, quoteReserve, tokenReserve),
    [readKey(PAIR, "totalSupply", [])]: 100n,
    [readKey(PAIR, "balanceOf", [NATIVE])]: 0n,
    [readKey(PAIR, "balanceOf", [DEAD])]: lpBurned,
  });
  const v3 = (quoteBalance: bigint) => ({ [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: V3_POOL, [readKey(USDC, "balanceOf", [V3_POOL])]: quoteBalance });
  const both = (positions: FakePosition[], reads: Record<string, unknown>, nftOwners: Record<number, string>, input: Partial<InspectInput> = {}) =>
    check([{ key, positions }], { dex: everything, chain: { reads, nftOwners }, input });

  it("adds a v2 pair's quote reserve to the v4 positions' quote: a burned pair doesn't hide a wallet's v4 position", async () => {
    // The pair: 29,553.010879 USDC, burned. The v4 position: as much, in a wallet, and being concentrated it takes more of
    // what buyers pay next than the pair does (as much again, against sqrt 2 - 1 of the pair's reserve).
    const f = await both([nft(7, L)], pair(100n, held(L).now), { 7: WALLET });
    expect(f).toMatchObject({ status: "fail", detail: expect.stringMatching(/^58\.9% of this token's liquidity is in positions wallets can withdraw, which hold 29,553 USDC now; 41\.1% is burned or locked\./) as string });
    const burned = await both([nft(7, L)], pair(100n, held(L).now), { 7: DEAD });
    expect(burned).toMatchObject({ status: "pass", evidenceUrl: expect.stringMatching(/instance\/7$|tab=holders$/) as string });
    expect(burned.detail).toMatch(/over 2 pool\(s\) holding 59,106 USDC now/);
  });

  it("splits a v2 pair by LP holder: unlocked LP is withdrawable, and in a known locker it is locked", async () => {
    // The pair holds half as much USDC as the burned v4 position: 90% of it unlocked is 30% of the USDC in the pools.
    const half = held(L).now / 2n;
    expect(await both([nft(7, L)], pair(10n, half), { 7: DEAD })).toMatchObject({ status: "warn", detail: expect.stringMatching(/^30% of this token's liquidity is in positions wallets can withdraw, which hold 13,298 USDC now; 70% is burned or locked\./) as string });
    const locked = await both([nft(7, L)], { ...pair(50n, half), [readKey(PAIR, "balanceOf", [LOCKER])]: 50n }, { 7: DEAD }, { knownLockers: [LOCKER] });
    expect(locked).toMatchObject({ status: "pass", detail: expect.stringContaining("(burned: 83.3%, locked: 16.7%)") as string });
    const unvetted = await both([nft(7, L)], pair(10n, half), { 7: DEAD }, { lockersVetted: false });
    expect(unvetted).toMatchObject({ status: "unknown", detail: expect.stringContaining("is v2 LP outside burn addresses and known lock contracts, and the lock contracts on Arc aren't recognized yet") as string });
  });

  it("looks ahead in a v2 pair to the same target as everywhere: its reserve times sqrt 2 - 1 when it is the reference, by LP share", async () => {
    const { input } = world([{ key, positions: [nft(7, L / 10n)] }], { dex: everything, chain: { reads: pair(40n, 10_000_000_000n), nftOwners: { 7: DEAD } } });
    const tally = (await tallyLiquidity(input, await findPools(input), everything))!;
    expect(tally.now.withdrawable).toBe(6_000_000_000n * SHARE_SCALE);
    // 10,000 × (sqrt 2 - 1) = 4,142.135623 more, 60% of it to the unlocked LP; the v4 pool, at the same price, looks to the
    // same target and gains what its range takes on the way.
    expect(tally.ahead.withdrawable / SHARE_SCALE).toBe(6_000_000_000n + 2_485_281_374n);
    expect(tally.ahead.burned / SHARE_SCALE).toBe(4_000_000_000n + 1_656_854_249n + held(L / 10n).now + held(L / 10n).inflow);
    expect(tally.lookAhead).toBe(true);
  });

  it("counts a v3 pool's USDC as unknown: a small one beside burned liquidity still passes, a large one can't", async () => {
    const small = await both([nft(7, L)], { ...noPools(everything), ...v3(1_000_000_000n) }, { 7: DEAD });
    expect(small).toMatchObject({ status: "pass", detail: expect.stringMatching(/^96\.7% of this token's liquidity is burned or locked/) as string });
    const large = await both([nft(7, L)], { ...noPools(everything), ...v3(29_553_010_879n) }, { 7: DEAD });
    expect(large).toMatchObject({
      status: "unknown",
      detail: `Of this token's liquidity, 50% is in Uniswap v3 pools, whose positions can't be read yet; 50% is burned or locked. Burned or locked needs 95% to pass. ${COUNTED}`,
      evidenceUrl: `https://explorer.test/address/${V3_POOL}`,
    });
  });

  it("isn't moved by a v3 pool's price or its tokens: dust USDC in one changes nothing", async () => {
    // One raw unit of USDC and any number of tokens, at any price: nothing of it is counted but the USDC.
    const f = await both([nft(7, L)], { ...noPools(everything), ...v3(1n), [readKey(TOKEN, "balanceOf", [V3_POOL])]: 10n ** 40n, [readKey(V3_POOL, "slot0", [])]: [sqrtRatioAtTick(600_000), 600_000] }, { 7: DEAD });
    expect(f.status).toBe("pass");
  });

  it("is unknown while a family of pools never answered", async () => {
    const { input } = world([], { dex: everything, chain: { reads: pair(100n, 5_000_000_000n), multicallReverts: true }, input: { extraPoolsTruncated: true } });
    const f = await checkLpLock(input, await findPools(input));
    expect(f.status).toBe("unknown");
    expect(f.detail).toContain("Uniswap v4 and Aerodrome didn't answer, so a pool there can't be ruled out.");
  });

  it("names both currencies when the pools quote in both", async () => {
    const f = await both([nft(7, L)], pair(100n, held(L).now, EURC.mainnet), { 7: WALLET });
    expect(f.detail).toMatch(/which hold 29,553 USDC\/EURC now/);
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
