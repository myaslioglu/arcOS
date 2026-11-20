import { describe, expect, it, vi } from "vitest";
import { AERODROME, EURC, UNISWAP_V4, USDC, type DexConfig } from "@arcos/chain";
import { SHARE_SCALE, checkLpLock, findPools, tallyLiquidity, v4PoolIdsToIndex } from "../checks";
import { inspect } from "../inspect";
import type { ExtraPool, Finding, InspectInput, V4PositionIndex, V4PositionKey } from "../types";
import { NATIVE, standardV4Keys, v4PoolId, v4PoolKey } from "../v4";
import { HEAD_MARGIN, positionValue } from "../v4-positions";
import { fakeChain, readKey, v2PairReads, type FakeChain, type FakePosition } from "./fixtures/chain-fake";
import { arcFields } from "./fixtures/arc";

// The lp-lock check with a position index (`InspectInput.v4Positions`): every pool's liquidity by who can withdraw it.
// Without an index the check is the one pools.test.ts and inspect.test.ts cover, unchanged.

const TOKEN = "0x1111111111111111111111111111111111111111"; // sorts below USDC: the token is currency0, USDC currency1
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
const noPools = (dex: DexConfig): Record<string, unknown> =>
  Object.fromEntries(
    dex.quoteTokens.flatMap((q) => [
      ...(dex.v2Factory ? [[readKey(dex.v2Factory, "getPair", [TOKEN, q.address]), NATIVE]] : []),
      ...(dex.v3Factory ? (dex.v3FeeTiers ?? []).map((fee) => [readKey(dex.v3Factory!, "getPool", [TOKEN, q.address, fee]), NATIVE]) : []),
      ...(dex.aero ? dex.aero.tickSpacings.map((spacing) => [readKey(dex.aero!.clFactory, "getPool", [TOKEN, q.address, spacing]), NATIVE]) : []),
    ]),
  );
const hookWith = (flags: string): `0x${string}` => `0x${"1".repeat(36)}${flags}`;
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;

const key = v4PoolKey(TOKEN, USDC, 500, 10);
const id = v4PoolId(key);
/** A PositionManager NFT position over [-600, 600]. */
const nft = (tokenId: number, liquidity: bigint): FakePosition => ({ owner: PM, tickLower: -600, tickUpper: 600, salt: salt(tokenId), liquidity });
const keyOf = ({ owner, tickLower, tickUpper, salt: s }: FakePosition): V4PositionKey => ({ owner: owner as `0x${string}`, tickLower, tickUpper, salt: s as `0x${string}` });
/** What a position of `liquidity` over [-600, 600] is worth at price 1, in USDC's 6 decimals: 59,106.021758 for 10^12. */
const worth = (liquidity: bigint): bigint => positionValue({ sqrtPriceX96: Q96, tickLower: -600, tickUpper: 600, liquidity, quoteIsCurrency0: false });

/** One v4 pool at price 1 holding `positions`, the index listing all of them, caught up. */
function setup(positions: FakePosition[], over: { chain?: FakeChain; dex?: DexConfig; poolKey?: typeof key; index?: V4PositionIndex | null; input?: Partial<InspectInput>; extraPools?: ExtraPool[] } = {}) {
  const poolKey = over.poolKey ?? key;
  const poolId = v4PoolId(poolKey);
  const reader = fakeChain({
    head: HEAD,
    v4: { [poolId]: { sqrtPriceX96: Q96, tick: 0, liquidity: positions.reduce((s, p) => s + p.liquidity, 0n), quote: { amountIn: 1n }, positions } },
    ...over.chain,
  });
  const index = over.index === undefined ? { cursor: Number(HEAD - HEAD_MARGIN), pools: { [poolId]: { positions: positions.map(keyOf), truncated: false } } } : over.index;
  const input: InspectInput = {
    ...arcFields("mainnet"),
    address: TOKEN, network: "mainnet", reader, explorer: null, dex: over.dex ?? v4Only, knownLockers: [], explorerBase: "https://explorer.test",
    ...(over.extraPools ? { extraPools: over.extraPools } : {}),
    ...(index ? { v4Positions: index } : {}),
    ...over.input,
  };
  return { reader, input };
}
async function lpLock(positions: FakePosition[], over: Parameters<typeof setup>[1] = {}): Promise<Finding> {
  const { input } = setup(positions, over);
  return checkLpLock(input, await findPools(input));
}
const owners = (map: Record<number, string>): FakeChain => ({ nftOwners: map });

describe("lp-lock over a Uniswap v4 pool's positions", () => {
  it("fails when a wallet holds the position: the share, its value, a Vault fix and the NFT's page", async () => {
    const f = await lpLock([nft(7, L)], { chain: owners({ 7: WALLET }) });
    expect(f).toEqual({
      id: "lp-lock",
      status: "fail",
      title: "Liquidity isn't locked",
      detail: "100% of the token's liquidity, about 59,106 USDC of value, is in positions wallets can withdraw. 0% is burned or locked.",
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
      detail: "100% of the token's liquidity can't be withdrawn (burned: 100%, locked: 0%), counted over 1 pool(s) at the current price.",
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: null,
    });
  });

  it("passes when a known locker holds it, and says which share is locked", async () => {
    const f = await lpLock([nft(1, 3n * L), nft(2, L)], { chain: owners({ 1: LOCKER, 2: NATIVE }), input: { knownLockers: [LOCKER] } });
    expect(f).toMatchObject({ status: "pass", detail: "100% of the token's liquidity can't be withdrawn (burned: 25%, locked: 75%), counted over 1 pool(s) at the current price." });
  });

  it("is unknown, never a fail, when a contract holds it: the contract may be a locker", async () => {
    const f = await lpLock([nft(7, L)], { chain: { ...owners({ 7: CONTRACT }), code: { [CONTRACT.toLowerCase()]: "0x6080" } } });
    expect(f).toMatchObject({
      status: "unknown",
      title: "Couldn't check liquidity locks",
      detail: "Of the token's liquidity, 100% is held by contracts whose lock terms can't be read. Burned or locked needs 95% to pass.",
      evidenceUrl: `https://explorer.test/token/${PM}/instance/7`,
      fixAppId: null,
    });
  });

  it("classifies a position held straight in the PoolManager by its sender: a contract, linked by its address", async () => {
    const own: FakePosition = { owner: SENDER, tickLower: -600, tickUpper: 600, salt: salt(0), liquidity: L };
    const f = await lpLock([own], { chain: { code: { [SENDER.toLowerCase()]: "0x6080" } } });
    expect(f).toMatchObject({ status: "unknown", evidenceUrl: `https://explorer.test/address/${SENDER.toLowerCase()}` });
    expect(f.detail).toMatch(/100% is held by contracts whose lock terms can't be read/);
  });

  it("counts an EIP-7702 wallet as a wallet", async () => {
    const f = await lpLock([nft(7, L)], { chain: { ...owners({ 7: WALLET }), code: { [WALLET.toLowerCase()]: `0xef0100${"ab".repeat(20)}` } } });
    expect(f.status).toBe("fail");
  });

  it("draws the lines at 95% safe and more than 5% withdrawable", async () => {
    const split = (burned: bigint, wallet: bigint, contract = 0n) =>
      lpLock([nft(1, burned * L), nft(2, wallet * L), ...(contract > 0n ? [nft(3, contract * L)] : [])], {
        chain: { ...owners({ 1: DEAD, 2: WALLET, 3: CONTRACT }), code: { [CONTRACT.toLowerCase()]: "0x6080" } },
      });
    expect(await split(95n, 5n)).toMatchObject({ status: "pass", detail: expect.stringMatching(/^95% of the token's liquidity can't be withdrawn/) as string });
    expect(await split(94n, 6n)).toMatchObject({ status: "fail", detail: expect.stringMatching(/^6% of the token's liquidity, about 354,636 USDC of value/) as string });
    // 90% burned, 5% in a wallet, 5% in a contract: not enough to pass, not enough withdrawable to fail.
    expect(await split(90n, 5n, 5n)).toMatchObject({
      status: "unknown",
      detail: "Of the token's liquidity, 5% is held by contracts whose lock terms can't be read; 5% is in positions wallets can withdraw; 90% is burned or locked. Burned or locked needs 95% to pass.",
    });
    // More than 5% in wallets fails whatever the rest is.
    expect((await split(50n, 6n, 44n)).status).toBe("fail");
  });

  it("links the largest position that isn't safe", async () => {
    const f = await lpLock([nft(1, 2n * L), nft(2, 5n * L), nft(3, 90n * L)], { chain: owners({ 1: WALLET, 2: WALLET_2, 3: DEAD }) });
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/2` });
  });

  it("drops positions that hold nothing, and can't judge pools that hold nothing at all", async () => {
    expect(await lpLock([nft(1, 0n), nft(2, L)], { chain: owners({ 2: DEAD }) })).toMatchObject({ status: "pass" });
    expect(await lpLock([nft(1, 0n)], { chain: owners({ 1: WALLET }) })).toMatchObject({ status: "unknown", detail: "The token's pools hold no liquidity to judge.", fixAppId: null });
  });

  describe("a hook that runs when liquidity is removed", () => {
    const hooked = (flags: string) => {
      const poolKey = v4PoolKey(TOKEN, USDC, 10_000, 200, hookWith(flags));
      return { poolKey, extraPools: [{ version: "v4", key: poolKey }] satisfies ExtraPool[] };
    };
    it.each([["BEFORE_REMOVE_LIQUIDITY", "0200"], ["AFTER_REMOVE_LIQUIDITY", "0100"], ["AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA", "0001"]])("makes a wallet's position unknown: %s", async (_name, flags) => {
      const f = await lpLock([nft(7, L)], { ...hooked(flags), chain: owners({ 7: WALLET }) });
      expect(f).toMatchObject({
        status: "unknown",
        detail: "Of the token's liquidity, 100% is in wallets' positions in a pool whose hook runs when liquidity is removed, so it can block or tax a withdrawal. Burned or locked needs 95% to pass.",
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

  describe("an index that can't be relied on is unknown, never a pass or a fail", () => {
    const burned = { chain: owners({ 7: DEAD }) };
    it("has no entry for the pool", async () => {
      const f = await lpLock([nft(7, L)], { ...burned, index: { cursor: Number(HEAD), pools: {} } });
      expect(f).toMatchObject({ status: "unknown", detail: "The position index has no entry yet for a Uniswap v4 pool of this token.", fixAppId: null });
    });
    it("is truncated", async () => {
      const f = await lpLock([nft(7, L)], { ...burned, index: { cursor: Number(HEAD), pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: true } } } });
      expect(f).toMatchObject({ status: "unknown", detail: "A Uniswap v4 pool of this token has more than 500 positions, more than this check reads." });
    });
    it("is more than 10,000 blocks behind", async () => {
      const f = await lpLock([nft(7, L)], { chain: { ...burned.chain, head: 50_000n }, index: { cursor: 30_000, pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: false } } } });
      expect(f).toMatchObject({ status: "unknown", detail: "The position index is catching up: it is more than 10,000 blocks behind the chain." });
    });
    it("lists positions that don't add up to the pool's liquidity", async () => {
      const f = await lpLock([nft(7, L), nft(8, L)], { chain: owners({ 7: DEAD, 8: WALLET }), index: { cursor: Number(HEAD), pools: { [id]: { positions: [keyOf(nft(7, L))], truncated: false } } } });
      expect(f).toMatchObject({ status: "unknown", detail: "The position index is catching up: the positions it lists for a Uniswap v4 pool don't add up to the pool's liquidity." });
    });
    it("names a position that doesn't answer", async () => {
      const f = await lpLock([nft(7, L)], { chain: { ...burned.chain, positionInfoFails: true } });
      expect(f).toMatchObject({ status: "unknown", detail: "The positions of a Uniswap v4 pool couldn't be read." });
    });
  });

  it("finds a position opened after the index's cursor, so a fresh wallet position still fails", async () => {
    const { input, reader } = setup([nft(7, 90n * L), nft(8, 10n * L)], {
      chain: {
        ...owners({ 7: DEAD, 8: WALLET }),
        logs: [{ topics: ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec", id, `0x${PM.slice(2).toLowerCase().padStart(64, "0")}`], data: `0x${"f".repeat(58)}fffda8${"0".repeat(58)}000258${"0".repeat(63)}1${salt(8).slice(2)}`, blockNumber: 950n }],
      },
      index: { cursor: 900, pools: { [id]: { positions: [keyOf(nft(7, 90n * L))], truncated: false } } },
    });
    const f = await checkLpLock(input, await findPools(input));
    expect(f).toMatchObject({ status: "fail", evidenceUrl: `https://explorer.test/token/${PM}/instance/8` });
    expect(reader.logQueries).toHaveLength(1);
  });

  it("answers as before the index when no index is given", async () => {
    const f = await lpLock([nft(7, L)], { chain: owners({ 7: WALLET }), index: null });
    expect(f).toMatchObject({ status: "unknown", detail: "Only Uniswap v4 pools were found, and liquidity positions in them can't be read without an index yet." });
  });

  it("leaves the classifying of many small holders out rather than read code for all of them", async () => {
    // 60 wallets with 1% each and one burned position of 40%: the 40 largest wallets are read, the other 20 aren't.
    const positions = [nft(1_000, 40n * L), ...Array.from({ length: 60 }, (_, i) => nft(i + 1, L))];
    const nftOwners = Object.fromEntries([[1_000, DEAD], ...positions.slice(1).map((_, i) => [i + 1, `0x${(0xb0b000 + i).toString(16).padStart(40, "0")}`])]) as Record<number, string>;
    const { input, reader } = setup(positions, { chain: { nftOwners } });
    let codeReads = 0;
    input.reader = { ...reader, getCode: (a) => (codeReads++, reader.getCode(a)) };
    const tally = await tallyLiquidity(input, await findPools(input), v4Only);
    expect(codeReads).toBe(40);
    expect(tally.withdrawable).toBe(40n * worth(L) * SHARE_SCALE);
    expect(tally.unknown.unclassified).toBe(20n * worth(L) * SHARE_SCALE);
    expect((await checkLpLock(input, await findPools(input))).status).toBe("fail");
  });
});

describe("a whole inspection with the position index", () => {
  it("carries the finding in the report, reads through the inspection's own reader, and isn't degraded by it", async () => {
    const { input, reader } = setup([nft(7, L)], { chain: { nftOwners: { 7: WALLET }, code: { [TOKEN]: "0x63a9059cbb00" } } });
    const report = await inspect(input);
    expect(report.findings.find((f) => f.id === "lp-lock")).toMatchObject({ status: "fail", title: "Liquidity isn't locked", fixAppId: "vault" });
    expect(report.degraded).toBe(false);
    expect(reader.batchBlocks.filter((b) => b !== undefined)).toEqual([HEAD - HEAD_MARGIN, HEAD - HEAD_MARGIN]);
  });

  it("marks the report degraded when the index's tail can't be read, and the finding unknown", async () => {
    const { input } = setup([nft(7, L)], {
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

describe("lp-lock over pools of several kinds", () => {
  const pair = (lpBurned: bigint, quoteReserve: bigint, quote = USDC) => ({
    ...noPools(everything),
    [readKey(V2, "getPair", [TOKEN, quote])]: PAIR,
    ...v2PairReads(PAIR, quote, TOKEN, quoteReserve),
    [readKey(PAIR, "totalSupply", [])]: 100n,
    [readKey(PAIR, "balanceOf", [NATIVE])]: 0n,
    [readKey(PAIR, "balanceOf", [DEAD])]: lpBurned,
  });
  /** A v3 pool holding `quoteBalance` USDC and `tokenBalance` tokens at price 1. */
  const v3 = (quoteBalance: bigint, tokenBalance = 0n, sqrtPriceX96: bigint | null = Q96) => ({
    [readKey(V3, "getPool", [TOKEN, USDC, 3000])]: V3_POOL,
    [readKey(USDC, "balanceOf", [V3_POOL])]: quoteBalance,
    [readKey(TOKEN, "balanceOf", [V3_POOL])]: tokenBalance,
    ...(sqrtPriceX96 === null ? {} : { [readKey(V3_POOL, "slot0", [])]: [sqrtPriceX96, 0] }),
  });
  const empty: V4PositionIndex = { cursor: Number(HEAD), pools: {} };
  const noV4 = async (reads: Record<string, unknown>, input: Partial<InspectInput> = {}) => {
    const reader = fakeChain({ head: HEAD, reads });
    const full: InspectInput = {
      ...arcFields("mainnet"),
      address: TOKEN, network: "mainnet", reader, explorer: null, dex: everything, knownLockers: [], explorerBase: "https://explorer.test", v4Positions: empty, ...input,
    };
    return checkLpLock(full, await findPools(full));
  };

  it("reads a lone v2 pair as it always did: by its LP supply", async () => {
    expect(await noV4(pair(96n, 5_000_000_000n))).toMatchObject({ status: "pass", detail: "96% of the v2 LP supply can't be withdrawn.", evidenceUrl: `https://explorer.test/token/${PAIR}?tab=holders` });
    expect(await noV4(pair(95n, 5_000_000_000n))).toMatchObject({ status: "pass" });
    expect(await noV4(pair(10n, 5_000_000_000n))).toMatchObject({ status: "fail", detail: "90% of the v2 LP supply sits in wallets that can withdraw it.", fixAppId: "vault" });
    expect(await noV4(pair(10n, 5_000_000_000n), { lockersVetted: false })).toMatchObject({
      status: "unknown",
      detail: "90% of the v2 LP supply isn't burned or in a known lock contract, and the lock contracts on Arc aren't recognized yet, so whether it can be withdrawn can't be told.",
    });
    expect(await noV4({ ...pair(0n, 5_000_000_000n), [readKey(PAIR, "totalSupply", [])]: 0n })).toMatchObject({ status: "unknown", detail: "The v2 LP token's totalSupply is 0." });
  });

  it("counts a v2 pair's LP in a known locker as locked", async () => {
    const f = await noV4({ ...pair(50n, 5_000_000_000n), [readKey(PAIR, "balanceOf", [LOCKER])]: 46n }, { knownLockers: [LOCKER] });
    expect(f).toMatchObject({ status: "pass", detail: "96% of the v2 LP supply can't be withdrawn." });
  });

  it("sizes a v3 pool it can't read into as unknown: a small one beside a burned pair still passes", async () => {
    // The pair is worth 10,000 (both reserves); the v3 pool 400 USDC and 100 tokens at price 1.
    const f = await noV4({ ...pair(100n, 5_000_000_000n), ...v3(400_000_000n, 100_000_000n) });
    expect(f).toMatchObject({ status: "pass", detail: "95.2% of the token's liquidity can't be withdrawn (burned: 95.2%, locked: 0%), counted over 2 pool(s) at the current price." });
  });

  it("can't pass beside a v3 pool that holds more than 5% of the liquidity, and says what share is unread", async () => {
    const f = await noV4({ ...pair(100n, 5_000_000_000n), ...v3(5_000_000_000n, 5_000_000_000n) });
    expect(f).toMatchObject({
      status: "unknown",
      detail: "Of the token's liquidity, 50% is in Uniswap v3 pools, whose positions can't be read yet; 50% is burned or locked. Burned or locked needs 95% to pass.",
      evidenceUrl: `https://explorer.test/address/${V3_POOL}`,
      fixAppId: null,
    });
  });

  it("still fails an unlocked pair beside a v3 pool when the wallets' share of everything is over 5%", async () => {
    expect((await noV4({ ...pair(10n, 500_000_000n), ...v3(5_000_000_000n) })).status).toBe("fail");
    // 90% of a pair that is 2% of the liquidity is 1.8% of it: neither line is crossed.
    expect((await noV4({ ...pair(10n, 50_000_000n), ...v3(4_900_000_000n) })).status).toBe("unknown");
  });

  it("is unknown when a v3 pool can't be sized: it holds tokens and its price doesn't answer", async () => {
    const f = await noV4({ ...pair(100n, 5_000_000_000n), ...v3(1n, 5n, null) });
    expect(f).toMatchObject({ status: "unknown", detail: "A Uniswap v3 pool couldn't be sized." });
  });

  it("is unknown while a family of pools never answered", async () => {
    const reader = fakeChain({ head: HEAD, reads: pair(100n, 5_000_000_000n), multicallReverts: true });
    // (Aerodrome's factory is asked inside a multicall, like v4's StateView.)
    const input: InspectInput = { ...arcFields("mainnet"), address: TOKEN, network: "mainnet", reader, explorer: null, dex: everything, knownLockers: [], explorerBase: "https://explorer.test", v4Positions: empty };
    const f = await checkLpLock(input, await findPools(input));
    expect(f).toMatchObject({ status: "unknown", detail: "Uniswap v4 and Aerodrome didn't answer, so a pool there can't be ruled out." });
  });

  it("adds a v2 pair and a v4 pool up by value: a burned pair doesn't hide a wallet's v4 position", async () => {
    // The pair: 2 × 29,553.010879 USDC burned. The v4 position: worth(10^12) = 59,106.021758 USDC, in a wallet.
    const over = { dex: everything, chain: { nftOwners: { 7: WALLET }, reads: pair(100n, worth(L) / 2n) } };
    const f = await lpLock([nft(7, L)], over);
    expect(f).toMatchObject({ status: "fail", detail: "50% of the token's liquidity, about 59,106 USDC of value, is in positions wallets can withdraw. 50% is burned or locked." });
    const burned = await lpLock([nft(7, L)], { ...over, chain: { ...over.chain, nftOwners: { 7: DEAD } } });
    expect(burned).toMatchObject({ status: "pass", detail: "100% of the token's liquidity can't be withdrawn (burned: 100%, locked: 0%), counted over 2 pool(s) at the current price." });
  });

  it("names USDC when the pools quote in more than one currency, and the one currency when they agree", async () => {
    const eur = await noV4({ ...pair(10n, 5_000_000_000n, EURC.mainnet), ...v3(1n) });
    expect(eur.detail).toMatch(/about 9,000 USDC of value/);
    const reader = fakeChain({ head: HEAD, reads: { ...pair(10n, 5_000_000_000n, EURC.mainnet), [readKey(V3, "getPool", [TOKEN, EURC.mainnet, 3000])]: V3_POOL, [readKey(EURC.mainnet, "balanceOf", [V3_POOL])]: 1n, [readKey(TOKEN, "balanceOf", [V3_POOL])]: 0n } });
    const input: InspectInput = { ...arcFields("mainnet"), address: TOKEN, network: "mainnet", reader, explorer: null, dex: everything, knownLockers: [], explorerBase: "https://explorer.test", v4Positions: empty };
    expect((await checkLpLock(input, await findPools(input))).detail).toMatch(/about 9,000 EURC of value/);
  });
});

describe("v4PoolIdsToIndex", () => {
  it("names the pools an inspection asks about: every standard key against every quote, then the index's own", () => {
    const hooked = v4PoolKey(TOKEN, USDC, 10_000, 200, hookWith("0200"));
    const ids = v4PoolIdsToIndex({ address: TOKEN, dex: everything, nativeQuote: arcFields("mainnet").nativeQuote, extraPools: [{ version: "v4", key: hooked }] });
    const standard = standardV4Keys(TOKEN, [USDC, EURC.mainnet, NATIVE]).map((k) => v4PoolId(k));
    expect(ids).toEqual([...standard, v4PoolId(hooked)]);
    expect(ids.every((x) => x === x.toLowerCase())).toBe(true);
  });
  it("names none where the chain has no v4", () => {
    expect(v4PoolIdsToIndex({ address: TOKEN, dex: { quoteTokens: [USD], v2Factory: V2 }, nativeQuote: null })).toEqual([]);
    expect(v4PoolIdsToIndex({ address: TOKEN, dex: null, nativeQuote: null })).toEqual([]);
  });
});
