import { encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { UNISWAP_V4, USDC } from "@arcos/chain";
import { sqrtRatioAtTick, v4PoolId, v4PoolKey } from "../v4";
import {
  HEAD_MARGIN,
  MAX_HOLDER_CODE_READS,
  MAX_POSITIONS,
  MAX_POSITIONS_PER_POOL,
  MODIFY_LIQUIDITY_TOPIC,
  TAIL_MAX_BLOCKS,
  amountsForLiquidity,
  balancesValue,
  classifyHolder,
  hookCanChangeRemoval,
  isPositionKey,
  positionFromLog,
  positionValue,
  readHolderCode,
  readV4Positions,
  type V4PoolRef,
} from "../v4-positions";
import type { ChainLog, V4PositionIndex, V4PositionKey } from "../types";
import { fakeChain, type FakePosition } from "./fixtures/chain-fake";

const Q96 = 1n << 96n;
/** Integer square root, for the reference prices below. */
function isqrt(n: bigint): bigint {
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
/** Uniswap's test helper `encodePriceSqrt(reserve1, reserve0)`: sqrt(reserve1 / reserve0) as a Q64.96. */
const encodePriceSqrt = (reserve1: bigint, reserve0: bigint): bigint => isqrt((reserve1 << 192n) / reserve0);

describe("amountsForLiquidity: Uniswap's LiquidityAmounts.getAmountsForLiquidity", () => {
  // The cases and the expected amounts of v3-periphery's test/LiquidityAmounts.spec.ts ("getAmountsForLiquidity"): a
  // range from price 100/110 to 110/100.
  const a = encodePriceSqrt(100n, 110n);
  const b = encodePriceSqrt(110n, 100n);

  it("splits liquidity into both currencies when the price is inside the range", () => {
    expect(amountsForLiquidity(encodePriceSqrt(1n, 1n), a, b, 2148n)).toEqual({ amount0: 99n, amount1: 99n });
  });

  it("is all currency0 when the price is below the range", () => {
    expect(amountsForLiquidity(encodePriceSqrt(99n, 110n), a, b, 1048n)).toEqual({ amount0: 99n, amount1: 0n });
  });

  it("is all currency1 when the price is above the range", () => {
    expect(amountsForLiquidity(encodePriceSqrt(111n, 100n), a, b, 2097n)).toEqual({ amount0: 0n, amount1: 199n });
  });

  it("treats a price exactly on the lower edge as below, and one on the upper edge as above", () => {
    expect(amountsForLiquidity(a, a, b, 1048n)).toEqual({ amount0: 99n, amount1: 0n });
    expect(amountsForLiquidity(b, a, b, 2097n)).toEqual({ amount0: 0n, amount1: 199n });
  });

  it("takes the range's two prices in either order, and holds nothing with no liquidity", () => {
    expect(amountsForLiquidity(encodePriceSqrt(1n, 1n), b, a, 2148n)).toEqual({ amount0: 99n, amount1: 99n });
    expect(amountsForLiquidity(encodePriceSqrt(1n, 1n), a, b, 0n)).toEqual({ amount0: 0n, amount1: 0n });
  });

  it("gives x = y = L for a full-range position at price 1, less what the range's ends cut off", () => {
    const L = 10n ** 18n;
    const { amount0, amount1 } = amountsForLiquidity(Q96, sqrtRatioAtTick(-887_220), sqrtRatioAtTick(887_220), L);
    // The ends are at sqrt price 2^-64 and 2^64 or so: each side is L * (1 - about 5.4e-20), cut down to the unit.
    for (const amount of [amount0, amount1]) {
      expect(amount).toBeLessThanOrEqual(L);
      expect(L - amount).toBeLessThan(10n);
    }
  });

  it("never rounds up: the two amounts, put back at the same price, give no more than the liquidity", () => {
    const [lower, upper, price] = [sqrtRatioAtTick(-1200), sqrtRatioAtTick(4000), sqrtRatioAtTick(137)];
    const L = 123_456_789_012_345_678n;
    const { amount0, amount1 } = amountsForLiquidity(price, lower, upper, L);
    // Uniswap's getLiquidityForAmount0 and getLiquidityForAmount1, exact: the liquidity each amount alone could back.
    const from0 = (amount0 * ((price * upper) / Q96)) / (upper - price);
    const from1 = (amount1 * Q96) / (price - lower);
    expect(from0).toBeLessThanOrEqual(L);
    expect(from1).toBeLessThanOrEqual(L);
    expect(L - from0).toBeLessThan(L / 10n ** 12n);
    expect(L - from1).toBeLessThan(L / 10n ** 12n);
  });
});

describe("positionValue: a position at the pool's price, in the quote currency", () => {
  const L = 10n ** 18n;
  const range = { tickLower: -600, tickUpper: 600 };
  const [lower, upper] = [sqrtRatioAtTick(-600), sqrtRatioAtTick(600)];

  it("adds the quote amount and the token amount at the price: at price 1 the two sides are worth their sum", () => {
    const { amount0, amount1 } = amountsForLiquidity(Q96, lower, upper, L);
    expect(amount0).toBeGreaterThan(0n);
    expect(positionValue({ sqrtPriceX96: Q96, ...range, liquidity: L, quoteIsCurrency0: false })).toBe(amount0 + amount1);
    expect(positionValue({ sqrtPriceX96: Q96, ...range, liquidity: L, quoteIsCurrency0: true })).toBe(amount0 + amount1);
  });

  it("prices the token side at the current price: currency1 per currency0 is (sqrtP / 2^96)^2", () => {
    // Price 4 (sqrtP = 2): the range [-600, 600] is all below it, so the position is all currency1.
    const high = 2n * Q96;
    const all1 = amountsForLiquidity(high, lower, upper, L).amount1;
    expect(positionValue({ sqrtPriceX96: high, ...range, liquidity: L, quoteIsCurrency0: false })).toBe(all1);
    expect(positionValue({ sqrtPriceX96: high, ...range, liquidity: L, quoteIsCurrency0: true })).toBe(all1 / 4n);
    // Price 1/4: all currency0, worth a quarter of its amount in currency1.
    const low = Q96 / 2n;
    const all0 = amountsForLiquidity(low, lower, upper, L).amount0;
    expect(positionValue({ sqrtPriceX96: low, ...range, liquidity: L, quoteIsCurrency0: true })).toBe(all0);
    expect(positionValue({ sqrtPriceX96: low, ...range, liquidity: L, quoteIsCurrency0: false })).toBe(all0 / 4n);
  });

  it("is one-sided exactly on a range edge: all currency0 at tickLower's price, all currency1 at tickUpper's", () => {
    expect(amountsForLiquidity(lower, lower, upper, L).amount1).toBe(0n);
    expect(amountsForLiquidity(upper, lower, upper, L).amount0).toBe(0n);
    expect(positionValue({ sqrtPriceX96: upper, ...range, liquidity: L, quoteIsCurrency0: false })).toBe((L * (upper - lower)) / Q96);
  });

  it("is zero without liquidity or without a price", () => {
    expect(positionValue({ sqrtPriceX96: Q96, ...range, liquidity: 0n, quoteIsCurrency0: false })).toBe(0n);
    expect(positionValue({ sqrtPriceX96: 0n, ...range, liquidity: L, quoteIsCurrency0: false })).toBe(0n);
  });
});

describe("balancesValue: a pool's two balances at its price", () => {
  it("adds the token balance at the price to the quote balance, whichever side the quote is", () => {
    expect(balancesValue({ sqrtPriceX96: 2n * Q96, quoteBalance: 100n, tokenBalance: 10n, quoteIsToken0: false })).toBe(140n);
    expect(balancesValue({ sqrtPriceX96: 2n * Q96, quoteBalance: 100n, tokenBalance: 40n, quoteIsToken0: true })).toBe(110n);
    expect(balancesValue({ sqrtPriceX96: 0n, quoteBalance: 100n, tokenBalance: 0n, quoteIsToken0: true })).toBe(100n);
  });
});

describe("the hook's remove-liquidity permissions", () => {
  const hooked = (flags: string) => hookCanChangeRemoval(v4PoolKey("0x1111111111111111111111111111111111111111", USDC, 500, 10, `0x${"1".repeat(36)}${flags}`));
  it("reads BEFORE_REMOVE_LIQUIDITY (1 << 9), AFTER_REMOVE_LIQUIDITY (1 << 8) and AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA (1 << 0)", () => {
    expect(hooked("0200")).toBe(true);
    expect(hooked("0100")).toBe(true);
    expect(hooked("0001")).toBe(true);
  });
  it("is false for every other permission, and for no hook", () => {
    // Everything but bits 9, 8 and 0: initialize, add liquidity, swap, donate and the other deltas.
    expect(hooked("3cfe")).toBe(false);
    expect(hookCanChangeRemoval(v4PoolKey("0x1111111111111111111111111111111111111111", USDC, 500, 10))).toBe(false);
  });
});

const POOL_ID = `0x${"ab".repeat(32)}` as const;
const SENDER = "0x00000000000000000000000000000000000a11ce";
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const modifyLog = (poolId: string, sender: string, tickLower: number, tickUpper: number, delta: bigint, s: `0x${string}`, block = 100n): ChainLog => ({
  topics: [MODIFY_LIQUIDITY_TOPIC, poolId as `0x${string}`, `0x${sender.slice(2).padStart(64, "0")}`],
  data: encodeAbiParameters([{ type: "int24" }, { type: "int24" }, { type: "int256" }, { type: "bytes32" }], [tickLower, tickUpper, delta, s]),
  blockNumber: block,
});

describe("positionFromLog", () => {
  it("has the event's topic0", () => {
    // keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"), as read in a log on Arc mainnet.
    expect(MODIFY_LIQUIDITY_TOPIC).toBe("0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec");
  });

  it("reads a real log: PositionManager NFT 332,087, full range, on pool 0x1505…f879 (Arc mainnet, block 32,211,901)", () => {
    const found = positionFromLog({
      topics: [MODIFY_LIQUIDITY_TOPIC, "0x1505e1ae7976e5c5d07ed89ab606edc66c6b0532b63a1cfbc82a3182ad02f879", "0x0000000000000000000000006049c9a0e26405c0985f9e3685c87d0ae917f82b"],
      data: "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2762e00000000000000000000000000000000000000000000000000000000000d89d2000000000000000000000000000000000000000000022ee0e687744334dcf15a0000000000000000000000000000000000000000000000000000000000051137",
    });
    expect(found).toEqual({
      poolId: "0x1505e1ae7976e5c5d07ed89ab606edc66c6b0532b63a1cfbc82a3182ad02f879",
      key: { owner: "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b", tickLower: -887_250, tickUpper: 887_250, salt: salt(0x51137) },
    });
  });

  it("is the same key whether liquidity was added or removed, and null for another event or a malformed log", () => {
    const added = positionFromLog(modifyLog(POOL_ID, SENDER, -60, 60, 5n, salt(7)));
    expect(positionFromLog(modifyLog(POOL_ID, SENDER, -60, 60, -5n, salt(7)))).toEqual(added);
    expect(positionFromLog({ ...modifyLog(POOL_ID, SENDER, -60, 60, 5n, salt(7)), topics: [`0x${"11".repeat(32)}`, POOL_ID, salt(1)] })).toBeNull();
    expect(positionFromLog({ topics: [MODIFY_LIQUIDITY_TOPIC, POOL_ID], data: "0x" })).toBeNull();
    expect(positionFromLog({ topics: [MODIFY_LIQUIDITY_TOPIC, POOL_ID, salt(1)], data: "0x1234" })).toBeNull();
  });
});

describe("isPositionKey", () => {
  const key: V4PositionKey = { owner: SENDER, tickLower: -60, tickUpper: 60, salt: salt(1) };
  it("accepts a key that can exist and refuses the rest", () => {
    expect(isPositionKey(key)).toBe(true);
    expect(isPositionKey({ ...key, owner: "0x12" })).toBe(false);
    expect(isPositionKey({ ...key, tickLower: 60, tickUpper: 60 })).toBe(false);
    expect(isPositionKey({ ...key, tickLower: -887_273 })).toBe(false);
    expect(isPositionKey({ ...key, tickUpper: 887_273 })).toBe(false);
    expect(isPositionKey({ ...key, tickLower: 0.5 })).toBe(false);
    expect(isPositionKey({ ...key, salt: "0x01" })).toBe(false);
    expect(isPositionKey(null)).toBe(false);
  });
});

describe("classifyHolder", () => {
  const LOCKER = "0x00000000000000000000000000000000000010c4";
  const context = (code: `0x${string}` | null | undefined) => ({ knownLockers: [LOCKER] as `0x${string}`[], code });
  it("knows burn addresses and the chain's lockers without reading code", () => {
    expect(classifyHolder("0x000000000000000000000000000000000000dEaD", context(undefined))).toBe("burned");
    expect(classifyHolder("0x0000000000000000000000000000000000000000", context(undefined))).toBe("burned");
    expect(classifyHolder(LOCKER.toUpperCase().replace("0X", "0x") as `0x${string}`, context(undefined))).toBe("locked");
  });
  it("calls an address without code a wallet, and an EIP-7702 delegation too", () => {
    expect(classifyHolder(SENDER, context(null))).toBe("wallet");
    expect(classifyHolder(SENDER, context(`0xef0100${"ab".repeat(20)}`))).toBe("wallet");
  });
  it("calls any other code a contract: never locked, never withdrawable", () => {
    expect(classifyHolder(SENDER, context("0x6080604052"))).toBe("contract");
    // 23 bytes that don't start with the delegation designator, and the designator at another length.
    expect(classifyHolder(SENDER, context(`0xef0200${"ab".repeat(20)}`))).toBe("contract");
    expect(classifyHolder(SENDER, context(`0xef0100${"ab".repeat(21)}`))).toBe("contract");
  });
  it("leaves a holder whose code wasn't read unclassified", () => {
    expect(classifyHolder(SENDER, context(undefined))).toBe("unclassified");
  });
});

describe("readHolderCode", () => {
  it("reads the code of the holders that need it, the largest first, and no more than the cap", async () => {
    const holders = Array.from({ length: MAX_HOLDER_CODE_READS + 5 }, (_, i) => ({ holder: `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`, value: BigInt(i + 1) }));
    const asked: string[] = [];
    const reader = { ...fakeChain(), getCode: async (a: `0x${string}`) => (asked.push(a), a.endsWith("2d") ? ("0x60" as const) : null) };
    const code = await readHolderCode(reader, [...holders, { holder: "0x000000000000000000000000000000000000dEaD", value: 10n ** 9n }, { ...holders[9]!, value: 1n }], []);
    expect(asked).toHaveLength(MAX_HOLDER_CODE_READS);
    expect(asked).not.toContain("0x000000000000000000000000000000000000dEaD");
    // The five smallest are left out; holder 10 counts once, with both of its positions.
    for (const small of holders.slice(0, 5)) expect(code.has(small.holder)).toBe(false);
    expect(code.get(holders[MAX_HOLDER_CODE_READS + 4]!.holder)).toBe("0x60");
    expect(code.get(holders[20]!.holder)).toBeNull();
  });
});

describe("readV4Positions", () => {
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const key = v4PoolKey(TOKEN, USDC, 500, 10);
  const id = v4PoolId(key);
  const pool: V4PoolRef = { poolId: id, key, quoteIsCurrency0: false, quoteDecimals: 6 };
  const PM = UNISWAP_V4.positionManager.toLowerCase();
  const WALLET = "0x00000000000000000000000000000000000B0b01"; // checksummed, as ownerOf decodes
  const nft = (tokenId: number, liquidity: bigint, tickLower = -600, tickUpper = 600): FakePosition => ({ owner: PM, tickLower, tickUpper, salt: salt(tokenId), liquidity });
  const keyOf = ({ owner, tickLower, tickUpper, salt: s }: FakePosition): V4PositionKey => ({ owner: owner as `0x${string}`, tickLower, tickUpper, salt: s as `0x${string}` });
  const L = 10n ** 12n;
  const HEAD = 1_000n;
  const index = (positions: FakePosition[], over: Partial<V4PositionIndex> & { truncated?: boolean } = {}): V4PositionIndex => ({
    cursor: over.cursor ?? Number(HEAD - HEAD_MARGIN),
    pools: over.pools ?? { [id]: { positions: positions.map(keyOf), truncated: over.truncated ?? false } },
  });
  const chain = (positions: FakePosition[], over: Parameters<typeof fakeChain>[0] = {}, active?: bigint) =>
    fakeChain({
      head: HEAD,
      v4: { [id]: { sqrtPriceX96: Q96, tick: 0, liquidity: active ?? positions.filter((p) => p.tickLower <= 0 && 0 < p.tickUpper).reduce((s, p) => s + p.liquidity, 0n), positions } },
      nftOwners: { 1: WALLET, 2: "0x000000000000000000000000000000000000dEaD" },
      ...over,
    });
  const read = (reader: ReturnType<typeof fakeChain>, idx: V4PositionIndex, pools = [pool]) => readV4Positions({ reader, v4: UNISWAP_V4, pools, index: idx });

  it("sizes each position that holds liquidity and names who can act on it: the NFT's owner, or the sender itself", async () => {
    const positions = [nft(1, L), nft(2, 3n * L), { owner: SENDER, tickLower: -60, tickUpper: 60, salt: salt(0), liquidity: L }, nft(3, 0n)];
    const reader = chain(positions);
    const [got] = await read(reader, index(positions));
    const value = (liquidity: bigint, lower: number, upper: number) => positionValue({ sqrtPriceX96: Q96, tickLower: lower, tickUpper: upper, liquidity, quoteIsCurrency0: false });
    expect(got).toEqual({
      pool,
      gap: null,
      positions: [
        { holder: WALLET, tokenId: 1n, value: value(L, -600, 600) },
        { holder: "0x000000000000000000000000000000000000dEaD", tokenId: 2n, value: value(3n * L, -600, 600) },
        { holder: SENDER, tokenId: null, value: value(L, -60, 60) },
      ],
    });
    // Everything at one block, a little behind the tip; and ownerOf only for the NFTs that hold liquidity.
    expect(new Set(reader.batchBlocks)).toEqual(new Set([HEAD - HEAD_MARGIN]));
    expect(reader.batches.flatMap((b) => b.calls).filter((c) => c.fn === "ownerOf").map((c) => c.args[0])).toEqual([1n, 2n]);
    expect(reader.logQueries).toEqual([]);
  });

  it("converts a native-USDC pool's 18-decimal amounts to 6", async () => {
    const positions = [{ owner: SENDER, tickLower: -600, tickUpper: 600, salt: salt(0), liquidity: 10n ** 24n }];
    const [got] = await read(chain(positions), index(positions), [{ ...pool, quoteDecimals: 18 }]);
    const raw = positionValue({ sqrtPriceX96: Q96, tickLower: -600, tickUpper: 600, liquidity: 10n ** 24n, quoteIsCurrency0: false });
    expect(got).toMatchObject({ gap: null, positions: [{ value: raw / 10n ** 12n }] });
  });

  it("reads the blocks after the index's cursor itself, and adds the positions they opened", async () => {
    const indexed = [nft(1, L)];
    const fresh = nft(2, 2n * L);
    const reader = chain([...indexed, fresh], { logs: [modifyLog(id, PM, -600, 600, 2n * L, salt(2)), modifyLog(id, PM, -600, 600, 1n, salt(1)), modifyLog(POOL_ID, PM, -600, 600, 1n, salt(9))] });
    const [got] = await read(reader, index(indexed, { cursor: 900 }));
    expect(got).toMatchObject({ gap: null, positions: [{ tokenId: 1n }, { tokenId: 2n }] });
    expect(reader.logQueries).toEqual([{ address: UNISWAP_V4.poolManager, topics: [MODIFY_LIQUIDITY_TOPIC, [id]], fromBlock: 901n, toBlock: HEAD - HEAD_MARGIN }]);
  });

  it("is stale when the cursor is more than 10,000 blocks behind, and reads nothing", async () => {
    const positions = [nft(1, L)];
    const reader = chain(positions, { head: 20_000n });
    expect(await read(reader, index(positions, { cursor: Number(20_000n - HEAD_MARGIN) - TAIL_MAX_BLOCKS - 1 }))).toEqual([{ pool, gap: "stale" }]);
    expect(reader.batches).toEqual([]);
    expect(reader.logQueries).toEqual([]);
    // Exactly 10,000 behind is still read.
    const edge = chain(positions, { head: 20_000n });
    expect(await read(edge, index(positions, { cursor: Number(20_000n - HEAD_MARGIN) - TAIL_MAX_BLOCKS }))).toMatchObject([{ gap: null }]);
    expect(await read(chain(positions), index(positions, { cursor: Number.NaN }))).toEqual([{ pool, gap: "stale" }]);
  });

  it("reads at its own block an index that is ahead of it: a position opened later holds nothing there yet", async () => {
    const positions = [nft(1, L)];
    const reader = chain(positions);
    expect(await read(reader, index(positions, { cursor: Number(HEAD) + 5 }))).toMatchObject([{ gap: null, positions: [{ tokenId: 1n }] }]);
    expect(reader.logQueries).toEqual([]);
  });

  it("says missing for a pool the index didn't look up, which an empty list is not", async () => {
    const reader = chain([]);
    expect(await read(reader, index([], { pools: {} }))).toEqual([{ pool, gap: "missing" }]);
    expect(await read(chain([]), index([]))).toEqual([{ pool, gap: null, positions: [] }]);
    // An entry under an inherited name is no entry.
    expect(await read(chain([]), index([], { pools: Object.create({ [id]: { positions: [], truncated: false } }) as V4PositionIndex["pools"] }))).toEqual([{ pool, gap: "missing" }]);
  });

  it("says truncated when the index says so, or the pool has more positions than it reads", async () => {
    expect(await read(chain([nft(1, L)]), index([nft(1, L)], { truncated: true }))).toEqual([{ pool, gap: "truncated" }]);
    const many = Array.from({ length: MAX_POSITIONS_PER_POOL + 1 }, (_, i) => nft(i + 10, 0n));
    expect(await read(chain(many), index(many))).toEqual([{ pool, gap: "truncated" }]);
    // The tail can push a full list over the cap.
    const full = many.slice(0, MAX_POSITIONS_PER_POOL);
    const over = chain(full, { logs: [modifyLog(id, PM, -600, 600, 1n, salt(9_999))] });
    expect(await read(over, index(full, { cursor: 900 }))).toEqual([{ pool, gap: "truncated" }]);
  });

  it("stops at the total it reads over all pools: the pools past it are truncated, the ones before are read", async () => {
    const pools = Array.from({ length: 5 }, (_, i) => {
      const k = v4PoolKey(TOKEN, USDC, 100 + i, 10);
      return { poolId: v4PoolId(k), key: k, quoteIsCurrency0: false, quoteDecimals: 6 } satisfies V4PoolRef;
    });
    const each = Array.from({ length: MAX_POSITIONS_PER_POOL }, (_, i) => nft(i + 1, 0n));
    const reader = fakeChain({ head: HEAD, v4: Object.fromEntries(pools.map((p) => [p.poolId, { sqrtPriceX96: Q96, tick: 0, liquidity: 0n, positions: each }])) });
    const got = await read(reader, { cursor: Number(HEAD), pools: Object.fromEntries(pools.map((p) => [p.poolId, { positions: each.map(keyOf), truncated: false }])) }, pools);
    expect(MAX_POSITIONS).toBe(4 * MAX_POSITIONS_PER_POOL);
    expect(got.map((r) => r.gap)).toEqual([null, null, null, null, "truncated"]);
  });

  it("says mismatch when the in-range positions don't add up to the pool's active liquidity", async () => {
    const positions = [nft(1, L), nft(2, L, 600, 1200)];
    // One more position is in range on chain than the list has.
    expect(await read(chain(positions, {}, 2n * L), index(positions))).toEqual([{ pool, gap: "mismatch" }]);
    // The out-of-range one doesn't count toward it: tickLower <= tick < tickUpper.
    expect(await read(chain(positions, {}, L), index(positions))).toMatchObject([{ gap: null }]);
    const edges = [nft(1, L, 0, 600), nft(2, L, -600, 0)];
    expect(await read(chain(edges, {}, L), index(edges))).toMatchObject([{ gap: null }]);
  });

  it("says unreadable when a list entry is malformed, a position doesn't answer, or an NFT with liquidity has no owner", async () => {
    const positions = [nft(1, L)];
    const bad = index(positions);
    bad.pools[id]!.positions.push({ owner: "0x12", tickLower: 0, tickUpper: 1, salt: salt(1) } as V4PositionKey);
    expect(await read(chain(positions), bad)).toEqual([{ pool, gap: "unreadable" }]);
    expect(await read(chain(positions, { positionInfoFails: true }), index(positions))).toEqual([{ pool, gap: "unreadable" }]);
    expect(await read(chain(positions, { nftOwners: {} }), index(positions))).toEqual([{ pool, gap: "unreadable" }]);
    expect(await read(chain(positions, { multicallReverts: true }), index(positions))).toEqual([{ pool, gap: "unreadable" }]);
  });

  it("rejects when the network fails: the tail's logs, or a multicall", async () => {
    const positions = [nft(1, L)];
    await expect(read(chain(positions, { logs: new Error("boom") }), index(positions, { cursor: 900 }))).rejects.toThrow("boom");
    await expect(read(chain(positions, { multicallError: new Error("down") }), index(positions))).rejects.toThrow("down");
  });

  it("splits a long list over several multicalls", async () => {
    const positions = Array.from({ length: 450 }, (_, i) => nft(i + 1, 0n));
    const reader = chain(positions);
    expect(await read(reader, index(positions))).toEqual([{ pool, gap: null, positions: [] }]);
    expect(reader.batches.map((b) => b.calls.length)).toEqual([200, 200, 52]);
  });
});
