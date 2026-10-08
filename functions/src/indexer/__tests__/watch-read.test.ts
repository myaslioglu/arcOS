import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { EURC, USDC, type Address } from "@arcos/chain";
import { CallReverted, IMPL_SLOT, ZEPPELINOS_IMPL_SLOT, quoteInRange } from "@arcos/inspector";
import { READ_TIMEOUT_MS, readWatchToken, type WatchReadInput } from "../watch-read";
import { EMPTY_SLOT, REVERT, fakeWatchReader, slotWord, type Call, type FakeWatchReaderOptions } from "./watch-fakes";

const TOKEN: Address = "0x8f3a000000000000000000000000000000009130";
const OWNER: Address = "0x1234000000000000000000000000000000000abc";
const OTHER: Address = "0x5678000000000000000000000000000000000ef0";
const IMPL: Address = "0xaaaa000000000000000000000000000000000001";
const ZOS: Address = "0xbbbb000000000000000000000000000000000002";
const PAIR: Address = "0x9999000000000000000000000000000000000009";
const BLOCK = 23_900_000;

/** A token that answers everything: owned by OWNER, 1,000 supply (18 decimals), not paused, "DUKE". */
function plain(call: Call): unknown {
  if (call.target !== TOKEN) return REVERT;
  switch (call.functionName) {
    case "owner":
      return OWNER;
    case "getOwner":
      return REVERT;
    case "totalSupply":
      return 1_000n * 10n ** 18n;
    case "paused":
      return false;
    case "symbol":
      return "DUKE";
    case "decimals":
      return 18;
    default:
      return REVERT;
  }
}

const input = (over: Partial<WatchReadInput> = {}): WatchReadInput => ({ network: "mainnet", token: TOKEN, pool: null, label: { symbol: "INDEXED", decimals: 9 }, ...over });
const read = (options: FakeWatchReaderOptions, over: Partial<WatchReadInput> = {}) => {
  const reader = fakeWatchReader(options);
  return readWatchToken(reader, input(over), BLOCK).then((result) => ({ ...result, reader }));
};

afterEach(() => vi.useRealTimers());

describe("readWatchToken", () => {
  it("makes three requests pinned to the block, every aggregate call allowed to fail, and maps a plain token", async () => {
    const { observation, failure, reader } = await read({ answer: plain });
    expect(failure).toBeNull();
    expect(reader.sent).toHaveLength(3);
    for (const sent of reader.sent) expect(sent.blockNumber).toBe(BigInt(BLOCK));
    const aggregate = reader.sent.find((s) => s.kind === "aggregate")!;
    expect(aggregate.kind === "aggregate" && aggregate.calls.map((c) => c.functionName)).toEqual(["owner", "getOwner", "totalSupply", "paused", "symbol", "decimals"]);
    expect(reader.sent.filter((s) => s.kind === "slot").map((s) => s.kind === "slot" && [s.address, s.slot])).toEqual([[TOKEN, IMPL_SLOT], [TOKEN, ZEPPELINOS_IMPL_SLOT]]);
    expect(observation).toEqual({
      block: BLOCK,
      owner: { ok: true, value: OWNER },
      totalSupply: { ok: true, value: 1_000n * 10n ** 18n },
      paused: { ok: true, value: false },
      implementation: { ok: true, value: null },
      pool: { ok: true, value: null },
      label: { symbol: "DUKE", decimals: 18, quote: null },
    });
  });

  it("falls back from owner() to getOwner(), lowercases it, and gives null when both revert", async () => {
    const viaGetOwner = await read({ answer: (c) => (c.functionName === "owner" ? REVERT : c.functionName === "getOwner" ? getAddress(OTHER) : plain(c)) });
    expect(viaGetOwner.observation.owner).toEqual({ ok: true, value: OTHER });
    const none = await read({ answer: (c) => (c.functionName === "owner" || c.functionName === "getOwner" ? REVERT : plain(c)) });
    expect(none.observation.owner).toEqual({ ok: true, value: null });
    expect(none.failure).toBeNull();
  });

  it("reads a reverted supply or pause flag as absent, never as unread", async () => {
    const { observation } = await read({ answer: (c) => (c.functionName === "totalSupply" || c.functionName === "paused" ? REVERT : plain(c)) });
    expect(observation.totalSupply).toEqual({ ok: true, value: null });
    expect(observation.paused).toEqual({ ok: true, value: null });
  });

  it("leaves owner, supply, pause and pool unread when the aggregate rejects, and names the failure", async () => {
    const pool = { id: PAIR, version: "v2" as const, quote: "USDC" as const, key: null };
    const transport = await read({ answer: plain, aggregate: new TypeError("fetch failed") }, { pool });
    expect(transport.failure).toBe("transport");
    expect(transport.observation).toMatchObject({ owner: { ok: false }, totalSupply: { ok: false }, paused: { ok: false }, pool: { ok: false }, implementation: { ok: true, value: null } });
    expect(transport.observation.label).toEqual({ symbol: "INDEXED", decimals: 9, quote: null });

    const reverted = await read({ answer: plain, aggregate: new CallReverted() });
    expect(reverted.failure).toBe("reverted");
    expect(reverted.observation.owner).toEqual({ ok: false });
  });

  it("reads the EIP-1967 slot first, then ZeppelinOS's, and null when both are empty", async () => {
    const eip1967 = await read({ answer: plain, slots: (_, slot) => (slot === IMPL_SLOT ? slotWord(IMPL) : slotWord(ZOS)) });
    expect(eip1967.observation.implementation).toEqual({ ok: true, value: IMPL });
    const zeppelin = await read({ answer: plain, slots: (_, slot) => (slot === ZEPPELINOS_IMPL_SLOT ? slotWord(ZOS) : EMPTY_SLOT) });
    expect(zeppelin.observation.implementation).toEqual({ ok: true, value: ZOS });
    const bare = await read({ answer: plain, slots: () => "0x" });
    expect(bare.observation.implementation).toEqual({ ok: true, value: null });
  });

  it("leaves the implementation unread on a malformed slot word (no failure) or a rejected slot read (a failure)", async () => {
    const malformed = await read({ answer: plain, slots: (_, slot) => (slot === IMPL_SLOT ? "0x01" : EMPTY_SLOT) });
    expect(malformed.observation.implementation).toEqual({ ok: false });
    expect(malformed.failure).toBeNull();
    expect(malformed.observation.owner).toEqual({ ok: true, value: OWNER });

    const rejected = await read({ answer: plain, slotRead: new Error("ECONNRESET") });
    expect(rejected.observation.implementation).toEqual({ ok: false });
    expect(rejected.failure).toBe("transport");
    expect(rejected.observation.owner).toEqual({ ok: true, value: OWNER });
  });

  it("reads a v2 pair's quote reserve from whichever side the address order puts it", async () => {
    const reserves = (c: Call) => (c.target === PAIR && c.functionName === "getReserves" ? [7_000_000n, 3_000_000n, 1] : plain(c));
    const pool = { id: PAIR, version: "v2" as const, quote: "USDC" as const, key: null };
    // USDC (0x3600…) sorts below TOKEN (0x8f3a…): reserve0 is the quote's.
    const low = await read({ answer: reserves }, { pool });
    expect(low.observation.pool).toEqual({ ok: true, value: { id: PAIR, depth: 7_000_000n } });
    expect(low.observation.label.quote).toBe("USDC");
    // A token below USDC: reserve1 is the quote's.
    const lowToken: Address = "0x1000000000000000000000000000000000000001";
    const high = await read({ answer: (c) => (c.target === lowToken ? plain({ ...c, target: TOKEN }) : reserves(c)) }, { pool, token: lowToken });
    expect(high.observation.pool).toEqual({ ok: true, value: { id: PAIR, depth: 3_000_000n } });
    // EURC sorts above TOKEN too.
    const eurc = await read({ answer: reserves }, { pool: { ...pool, quote: "EURC" } });
    expect(eurc.observation.pool).toEqual({ ok: true, value: { id: PAIR, depth: 3_000_000n } });
    expect(eurc.observation.label.quote).toBe("EURC");
  });

  it("reads a v3 or Aerodrome pool's depth as the quote token's balance of the pool", async () => {
    const pool = { id: PAIR, version: "v3" as const, quote: "EURC" as const, key: null };
    const { observation, reader } = await read({ answer: (c) => (c.functionName === "balanceOf" ? 42_000_000n : plain(c)) }, { pool });
    expect(observation.pool).toEqual({ ok: true, value: { id: PAIR, depth: 42_000_000n } });
    const aggregate = reader.sent.find((s) => s.kind === "aggregate")!;
    const ask = aggregate.kind === "aggregate" ? aggregate.calls.at(-1)! : null!;
    expect(ask).toEqual({ target: EURC.mainnet, functionName: "balanceOf", args: [PAIR] });
    const aero = await read({ answer: (c) => (c.functionName === "balanceOf" && c.target === USDC ? 5n : plain(c)) }, { pool: { ...pool, version: "aero", quote: "USDC" } });
    expect(aero.observation.pool).toEqual({ ok: true, value: { id: PAIR, depth: 5n } });
  });

  it("prices a v4 pool with quoteInRange, in 6-decimal units for USDC and divided by 10^12 for native USDC", async () => {
    const id = `0x${"ab".repeat(32)}`;
    const sqrtPriceX96 = 2n ** 96n * 2n; // price 4
    const tick = 13_863;
    const liquidity = 10n ** 18n;
    const answer = (c: Call) => (c.functionName === "getSlot0" ? [sqrtPriceX96, tick, 0, 500] : c.functionName === "getLiquidity" ? liquidity : plain(c));
    const usdcKey = { currency0: USDC, currency1: TOKEN, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" as Address };
    const usdc = await read({ answer }, { pool: { id, version: "v4", quote: "USDC", key: usdcKey } });
    const held = quoteInRange({ sqrtPriceX96, tick, tickSpacing: 10, liquidity, quoteIsCurrency0: true });
    expect(held).toBeGreaterThan(0n);
    expect(usdc.observation.pool).toEqual({ ok: true, value: { id, depth: held } });

    const nativeKey = { ...usdcKey, currency0: "0x0000000000000000000000000000000000000000" as Address };
    const native = await read({ answer }, { pool: { id, version: "v4", quote: "USDC-native", key: nativeKey } });
    expect(native.observation.pool).toEqual({ ok: true, value: { id, depth: held / 10n ** 12n } });
    expect(native.observation.label.quote).toBe("USDC");
    const { reader } = native;
    const aggregate = reader.sent.find((s) => s.kind === "aggregate")!;
    expect(aggregate.kind === "aggregate" && aggregate.calls.slice(-2).map((c) => c.functionName)).toEqual(["getSlot0", "getLiquidity"]);
  });

  it("leaves the pool unread when its call failed inside an aggregate that answered, and absent for a pool it can't price", async () => {
    const pool = { id: PAIR, version: "v3" as const, quote: "USDC" as const, key: null };
    const failed = await read({ answer: (c) => (c.functionName === "balanceOf" ? REVERT : plain(c)) }, { pool });
    expect(failed.observation.pool).toEqual({ ok: false });
    expect(failed.observation.owner).toEqual({ ok: true, value: OWNER });
    expect(failed.failure).toBeNull();
    const unpriced = await read({ answer: plain }, { pool: { id: PAIR, version: "v2", quote: "USDC-native", key: null } });
    expect(unpriced.observation.pool).toEqual({ ok: true, value: null });
    const keyless = await read({ answer: plain }, { pool: { id: `0x${"ab".repeat(32)}`, version: "v4", quote: "USDC", key: null } });
    expect(keyless.observation.pool).toEqual({ ok: true, value: null });
  });

  it("takes the label from the chain, falling back to the index's for a bytes32 symbol or unreadable decimals", async () => {
    const bytes32 = await read({ answer: (c) => (c.functionName === "symbol" ? { raw: `0x${"44554b45".padEnd(64, "0")}` as const } : c.functionName === "decimals" ? REVERT : plain(c)) });
    expect(bytes32.observation.label).toEqual({ symbol: "INDEXED", decimals: 9, quote: null });
    const unsafe = await read({ answer: (c) => (c.functionName === "symbol" ? "D‮UKE\nx" : plain(c)) });
    expect(unsafe.observation.label.symbol).toBe("DUKEx");
  });

  it("gives up on a request after 5 s, leaving its fields unread with the failure timeout", async () => {
    vi.useFakeTimers();
    const reader = fakeWatchReader({ answer: plain, aggregate: "hang" });
    const pending = readWatchToken(reader, input(), BLOCK);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { observation, failure } = await pending;
    expect(failure).toBe("timeout");
    expect(observation).toMatchObject({ owner: { ok: false }, totalSupply: { ok: false }, paused: { ok: false }, pool: { ok: false }, implementation: { ok: true, value: null } });
    expect(READ_TIMEOUT_MS).toBe(5_000);

    const slow = fakeWatchReader({ answer: plain, slotRead: "hang" });
    const slots = readWatchToken(slow, input(), BLOCK);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    const result = await slots;
    expect(result.failure).toBe("timeout");
    expect(result.observation.implementation).toEqual({ ok: false });
    expect(result.observation.owner).toEqual({ ok: true, value: OWNER });
  });
});
