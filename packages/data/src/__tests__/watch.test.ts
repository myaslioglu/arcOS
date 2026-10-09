import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BURN_ADDRESSES, type Address } from "@arcos/chain";
import type { AlertDetail, AlertKind, WatchStateRecord } from "../docs";
import {
  alertText,
  diffWatchState,
  displaySymbol,
  formatTokenUnits,
  isBurnAddress,
  nextWatchState,
  sanitizeSymbol,
  seen,
  short,
  watchStatePatchToDoc,
  type Read,
  type WatchObservation,
} from "../watch";
import { at } from "./helpers/timestamp";

// Watchdog's rules (design 1.3): what an observation raises against the stored state, what gets written, and the words.

const TOKEN: Address = "0x8f3a00000000000000000000000000000000913c";
const OWNER_A: Address = `0x1234${"0".repeat(32)}abcd`;
const OWNER_B: Address = `0x5678${"0".repeat(32)}ef01`;
const IMPL_A: Address = "0xaaaa0000000000000000000000000000000000aa";
const IMPL_B: Address = "0xbbbb0000000000000000000000000000000000bb";
const POOL_A = "0xcccc0000000000000000000000000000000000cc";
const POOL_B = "0xdddd0000000000000000000000000000000000dd";
const ZERO = BURN_ADDRESSES[0]!;
const DEAD = BURN_ADDRESSES[1]!;
const NOW = at(1_790_000_000_000);

const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const unread: Read<never> = { ok: false };

const state = (over: Partial<WatchStateRecord> = {}): WatchStateRecord => ({
  network: "mainnet",
  token: TOKEN,
  owner: OWNER_A,
  totalSupply: 1_000_000n * 10n ** 18n,
  paused: false,
  implementation: null,
  bestPool: POOL_A,
  bestPoolDepth: 10_000_000_000n,
  checkedBlock: 100,
  watchers: 1,
  lastCheckedAt: at(1_789_000_000_000),
  ...over,
});

/** An observation that matches `state()` exactly, at a later block: the no-change case. */
const observation = (over: Partial<WatchObservation> = {}): WatchObservation => ({
  block: 200,
  owner: ok(OWNER_A),
  totalSupply: ok(1_000_000n * 10n ** 18n),
  paused: ok(false),
  implementation: ok(null),
  pool: ok({ id: POOL_A, depth: 10_000_000_000n }),
  label: { symbol: "DUKE", decimals: 18, quote: "USDC" },
  ...over,
});

const kinds = (drafts: { kind: AlertKind }[]) => drafts.map((d) => d.kind);

describe("seen", () => {
  it("is a checked block above zero", () => {
    expect(seen(state({ checkedBlock: 0 }))).toBe(false);
    expect(seen(state({ checkedBlock: 1 }))).toBe(true);
  });
});

describe("diffWatchState: when nothing is said", () => {
  it("alerts nothing on first sight, whatever was read", () => {
    expect(diffWatchState(null, observation({ owner: ok(OWNER_B), paused: ok(true), totalSupply: ok(5n) }))).toEqual([]);
  });

  it("treats a record never seen as first sight: a proxy's implementation appearing at block 0 → an address is no change", () => {
    const unseen = state({ checkedBlock: 0, owner: null, totalSupply: null, paused: null, implementation: null, bestPool: null, bestPoolDepth: null });
    expect(diffWatchState(unseen, observation({ implementation: ok(IMPL_A) }))).toEqual([]);
    expect(diffWatchState(state({ checkedBlock: 0, implementation: null }), observation({ implementation: ok(IMPL_A), owner: ok(OWNER_B) }))).toEqual([]);
  });

  it("alerts nothing for an identical state", () => {
    expect(diffWatchState(state(), observation())).toEqual([]);
  });

  it("alerts nothing for a block at or before the stored one", () => {
    const changed = observation({ owner: ok(OWNER_B), paused: ok(true) });
    expect(diffWatchState(state({ checkedBlock: 200 }), changed)).toEqual([]);
    expect(diffWatchState(state({ checkedBlock: 300 }), changed)).toEqual([]);
    expect(diffWatchState(state({ checkedBlock: 199 }), changed)).toHaveLength(2);
  });

  it("alerts nothing for an unread field, whatever it was before", () => {
    const everythingUnread = observation({ owner: unread, totalSupply: unread, paused: unread, implementation: unread, pool: unread });
    expect(diffWatchState(state({ owner: OWNER_B, paused: true, totalSupply: 1n, implementation: IMPL_A, bestPoolDepth: 1n }), everythingUnread)).toEqual([]);
  });
});

describe("diffWatchState: owner_changed", () => {
  it("alerts when both owners are known and differ, with lowercase addresses", () => {
    const upper = `0x${OWNER_B.slice(2).toUpperCase()}` as Address;
    const drafts = diffWatchState(state(), observation({ owner: ok(upper) }));
    expect(drafts).toEqual([
      {
        kind: "owner_changed",
        block: 200,
        detail: { symbol: "DUKE", decimals: 18, from: OWNER_A, to: OWNER_B, quote: "USDC", pool: null, renounced: false, pct: null },
      },
    ]);
  });

  it("is not a change when only the case differs", () => {
    const upper = `0x${OWNER_A.slice(2).toUpperCase()}` as Address;
    expect(diffWatchState(state(), observation({ owner: ok(upper) }))).toEqual([]);
  });

  it("says renounced when the new owner is a burn address", () => {
    for (const burn of BURN_ADDRESSES) {
      const [draft] = diffWatchState(state(), observation({ owner: ok(burn) }));
      expect(draft).toMatchObject({ kind: "owner_changed", detail: { from: OWNER_A, to: burn.toLowerCase(), renounced: true } });
    }
  });

  it("alerts nothing from one burn address to another", () => {
    expect(diffWatchState(state({ owner: ZERO }), observation({ owner: ok(DEAD) }))).toEqual([]);
    expect(diffWatchState(state({ owner: DEAD.toLowerCase() as Address }), observation({ owner: ok(ZERO) }))).toEqual([]);
  });

  it("alerts when a burn address hands over to a wallet, not renounced", () => {
    const [draft] = diffWatchState(state({ owner: ZERO }), observation({ owner: ok(OWNER_B) }));
    expect(draft).toMatchObject({ kind: "owner_changed", detail: { from: ZERO, to: OWNER_B, renounced: false } });
  });

  it("alerts nothing when the owner was unknown, or is now: a flapping revert is not a change of hands", () => {
    expect(diffWatchState(state({ owner: null }), observation({ owner: ok(OWNER_B) }))).toEqual([]);
    expect(diffWatchState(state(), observation({ owner: ok(null) }))).toEqual([]);
    expect(diffWatchState(state({ owner: null }), observation({ owner: ok(null) }))).toEqual([]);
    expect(diffWatchState(state(), observation({ owner: unread }))).toEqual([]);
  });
});

describe("diffWatchState: supply_increased", () => {
  it("alerts when the supply grew, with raw units as decimal strings", () => {
    const drafts = diffWatchState(state({ totalSupply: 100n }), observation({ totalSupply: ok(101n) }));
    expect(drafts).toEqual([
      {
        kind: "supply_increased",
        block: 200,
        detail: { symbol: "DUKE", decimals: 18, from: "100", to: "101", quote: "USDC", pool: null, renounced: false, pct: null },
      },
    ]);
  });

  it("alerts nothing for the same supply, a decrease, or a supply unknown on either side", () => {
    expect(diffWatchState(state({ totalSupply: 100n }), observation({ totalSupply: ok(100n) }))).toEqual([]);
    expect(diffWatchState(state({ totalSupply: 100n }), observation({ totalSupply: ok(99n) }))).toEqual([]);
    expect(diffWatchState(state({ totalSupply: 100n }), observation({ totalSupply: ok(0n) }))).toEqual([]);
    expect(diffWatchState(state({ totalSupply: null }), observation({ totalSupply: ok(100n) }))).toEqual([]);
    expect(diffWatchState(state({ totalSupply: 100n }), observation({ totalSupply: ok(null) }))).toEqual([]);
    expect(diffWatchState(state({ totalSupply: 100n }), observation({ totalSupply: unread }))).toEqual([]);
  });
});

describe("diffWatchState: paused and unpaused", () => {
  it("alerts paused on false → true and unpaused on true → false", () => {
    expect(kinds(diffWatchState(state({ paused: false }), observation({ paused: ok(true) })))).toEqual(["paused"]);
    expect(kinds(diffWatchState(state({ paused: true }), observation({ paused: ok(false) })))).toEqual(["unpaused"]);
    const [draft] = diffWatchState(state({ paused: false }), observation({ paused: ok(true) }));
    expect(draft!.detail).toEqual({ symbol: "DUKE", decimals: 18, from: null, to: null, quote: "USDC", pool: null, renounced: false, pct: null });
  });

  it("alerts nothing for the same state, or for null on either side", () => {
    expect(diffWatchState(state({ paused: true }), observation({ paused: ok(true) }))).toEqual([]);
    expect(diffWatchState(state({ paused: null }), observation({ paused: ok(true) }))).toEqual([]);
    expect(diffWatchState(state({ paused: false }), observation({ paused: ok(null) }))).toEqual([]);
    expect(diffWatchState(state({ paused: false }), observation({ paused: unread }))).toEqual([]);
  });
});

describe("diffWatchState: implementation_changed", () => {
  it("alerts on a new implementation, on one appearing and on one disappearing", () => {
    expect(diffWatchState(state({ implementation: IMPL_A }), observation({ implementation: ok(IMPL_B) }))[0]).toMatchObject({
      kind: "implementation_changed",
      detail: { from: IMPL_A, to: IMPL_B },
    });
    expect(diffWatchState(state({ implementation: null }), observation({ implementation: ok(IMPL_A) }))[0]).toMatchObject({
      kind: "implementation_changed",
      detail: { from: null, to: IMPL_A },
    });
    expect(diffWatchState(state({ implementation: IMPL_A }), observation({ implementation: ok(null) }))[0]).toMatchObject({
      kind: "implementation_changed",
      detail: { from: IMPL_A, to: null },
    });
  });

  it("alerts nothing for the same implementation in any case, none on both sides, or an unread slot", () => {
    const upper = `0x${IMPL_A.slice(2).toUpperCase()}` as Address;
    expect(diffWatchState(state({ implementation: IMPL_A }), observation({ implementation: ok(upper) }))).toEqual([]);
    expect(diffWatchState(state({ implementation: null }), observation({ implementation: ok(null) }))).toEqual([]);
    expect(diffWatchState(state({ implementation: IMPL_A }), observation({ implementation: unread }))).toEqual([]);
  });
});

describe("diffWatchState: liquidity_dropped", () => {
  const pool = (depth: bigint, id = POOL_A) => observation({ pool: ok({ id, depth }) });

  it("alerts for 500 units that are just over 30%: both thresholds met at once, each at its floor", () => {
    // 500 units of 1,666.666666 is 30.00000001%: there is no integer depth of which exactly 500 units is exactly 30%.
    // The two exact boundaries (30% of 10,000; 500 of 1,000) are the next cases.
    const prevDepth = 1_666_666_666n;
    const drop = 500_000_000n;
    expect(drop * 10_000n >= prevDepth * 3000n).toBe(true);
    const drafts = diffWatchState(state({ bestPoolDepth: prevDepth }), pool(prevDepth - drop));
    expect(drafts).toEqual([
      {
        kind: "liquidity_dropped",
        block: 200,
        detail: {
          symbol: "DUKE",
          decimals: 18,
          from: "1666666666",
          to: "1166666666",
          quote: "USDC",
          pool: POOL_A,
          renounced: false,
          pct: 30,
        },
      },
    ]);
  });

  it("alerts at exactly 30% of a deep pool", () => {
    const [draft] = diffWatchState(state({ bestPoolDepth: 10_000_000_000n }), pool(7_000_000_000n));
    expect(draft).toMatchObject({ kind: "liquidity_dropped", detail: { from: "10000000000", to: "7000000000", pct: 30 } });
  });

  it("alerts nothing at 29.99%", () => {
    expect(diffWatchState(state({ bestPoolDepth: 10_000_000_000n }), pool(7_001_000_000n))).toEqual([]);
  });

  it("alerts nothing for a drop of 499.999999 units, however large a share", () => {
    expect(diffWatchState(state({ bestPoolDepth: 500_000_000n }), pool(1n))).toEqual([]);
    expect(diffWatchState(state({ bestPoolDepth: 600_000_000n }), pool(100_000_001n))).toEqual([]);
  });

  it("alerts for a drop of 500 units from 1,000", () => {
    const [draft] = diffWatchState(state({ bestPoolDepth: 1_000_000_000n }), pool(500_000_000n));
    expect(draft).toMatchObject({ kind: "liquidity_dropped", detail: { pct: 50 } });
  });

  it("truncates the percentage to a whole number", () => {
    const [draft] = diffWatchState(state({ bestPoolDepth: 3_000_000_000n }), pool(1_000_000_001n));
    expect(draft).toMatchObject({ kind: "liquidity_dropped", detail: { pct: 66 } });
  });

  it("alerts nothing when the deepest pool changed, when the depth rose, or when the pool is unread or absent", () => {
    expect(diffWatchState(state({ bestPoolDepth: 10_000_000_000n }), pool(1n, POOL_B))).toEqual([]);
    expect(diffWatchState(state({ bestPoolDepth: 10_000_000_000n }), pool(20_000_000_000n))).toEqual([]);
    expect(diffWatchState(state({ bestPoolDepth: 10_000_000_000n }), observation({ pool: unread }))).toEqual([]);
    expect(diffWatchState(state({ bestPoolDepth: 10_000_000_000n }), observation({ pool: ok(null) }))).toEqual([]);
  });

  it("alerts nothing when no pool or depth was stored, or the stored depth was zero", () => {
    expect(diffWatchState(state({ bestPool: null, bestPoolDepth: null }), pool(0n))).toEqual([]);
    expect(diffWatchState(state({ bestPoolDepth: 0n }), pool(0n))).toEqual([]);
  });

  it("matches the pool id in any case", () => {
    const upper = `0x${POOL_A.slice(2).toUpperCase()}`;
    expect(diffWatchState(state({ bestPoolDepth: 10_000_000_000n }), pool(0n, upper))).toHaveLength(1);
  });
});

describe("diffWatchState: several at once", () => {
  it("lists the alerts in a fixed order: owner, supply, pause, implementation, liquidity", () => {
    const drafts = diffWatchState(
      state({ totalSupply: 1n, implementation: IMPL_A, bestPoolDepth: 10_000_000_000n }),
      observation({ owner: ok(OWNER_B), totalSupply: ok(2n), paused: ok(true), implementation: ok(IMPL_B), pool: ok({ id: POOL_A, depth: 0n }) }),
    );
    expect(kinds(drafts)).toEqual(["owner_changed", "supply_increased", "paused", "implementation_changed", "liquidity_dropped"]);
    for (const draft of drafts) expect(draft.block).toBe(200);
    for (const draft of drafts) expect(draft.detail).toMatchObject({ symbol: "DUKE", decimals: 18, quote: "USDC" });
  });
});

describe("nextWatchState: first sight", () => {
  it("writes every field, the block and the time when the four core reads are ok", () => {
    const upper = `0x${OWNER_A.slice(2).toUpperCase()}` as Address;
    expect(nextWatchState(null, observation({ owner: ok(upper), implementation: ok(IMPL_A), block: 50 }), NOW)).toEqual({
      owner: OWNER_A,
      totalSupply: 1_000_000n * 10n ** 18n,
      paused: false,
      implementation: IMPL_A,
      bestPool: POOL_A,
      bestPoolDepth: 10_000_000_000n,
      checkedBlock: 50,
      lastCheckedAt: NOW,
    });
  });

  it("stores absent values as null, and an unread pool as none", () => {
    expect(nextWatchState(null, observation({ owner: ok(null), totalSupply: ok(null), paused: ok(null), implementation: ok(null), pool: unread }), NOW)).toEqual({
      owner: null,
      totalSupply: null,
      paused: null,
      implementation: null,
      bestPool: null,
      bestPoolDepth: null,
      checkedBlock: 200,
      lastCheckedAt: NOW,
    });
    expect(nextWatchState(null, observation({ pool: ok(null) }), NOW)).toMatchObject({ bestPool: null, bestPoolDepth: null });
  });

  it.each(["owner", "totalSupply", "paused", "implementation"] as const)("writes nothing when %s is unread", (field) => {
    expect(nextWatchState(null, observation({ [field]: unread }), NOW)).toBeNull();
  });

  it("treats a record never seen as first sight: the full patch when the core reads are ok, nothing otherwise", () => {
    const unseen = state({ checkedBlock: 0, owner: null, totalSupply: null, paused: null, implementation: null, bestPool: null, bestPoolDepth: null });
    expect(nextWatchState(unseen, observation({ implementation: ok(IMPL_A), block: 50 }), NOW)).toEqual({
      owner: OWNER_A,
      totalSupply: 1_000_000n * 10n ** 18n,
      paused: false,
      implementation: IMPL_A,
      bestPool: POOL_A,
      bestPoolDepth: 10_000_000_000n,
      checkedBlock: 50,
      lastCheckedAt: NOW,
    });
    expect(nextWatchState(unseen, observation({ owner: unread }), NOW)).toBeNull();
    expect(nextWatchState(state({ checkedBlock: 0 }), observation({ paused: unread }), NOW)).toBeNull();
  });
});

describe("nextWatchState: later checks", () => {
  it("writes nothing when nothing changed", () => {
    expect(nextWatchState(state(), observation(), NOW)).toBeNull();
    const upper = `0x${OWNER_A.slice(2).toUpperCase()}` as Address;
    expect(nextWatchState(state(), observation({ owner: ok(upper) }), NOW)).toBeNull();
  });

  it("writes nothing when every field is unread", () => {
    expect(nextWatchState(state(), observation({ owner: unread, totalSupply: unread, paused: unread, implementation: unread, pool: unread }), NOW)).toBeNull();
  });

  it("writes nothing for a block at or before the stored one", () => {
    expect(nextWatchState(state({ checkedBlock: 200 }), observation({ owner: ok(OWNER_B) }), NOW)).toBeNull();
    expect(nextWatchState(state({ checkedBlock: 201 }), observation({ owner: ok(OWNER_B) }), NOW)).toBeNull();
  });

  it("writes only the fields that changed, with the block and the time", () => {
    expect(nextWatchState(state(), observation({ owner: ok(OWNER_B), paused: ok(true) }), NOW)).toEqual({
      owner: OWNER_B,
      paused: true,
      checkedBlock: 200,
      lastCheckedAt: NOW,
    });
  });

  it("leaves an unread field as it is while writing another", () => {
    const patch = nextWatchState(state(), observation({ owner: unread, totalSupply: ok(5n) }), NOW);
    expect(patch).toEqual({ totalSupply: 5n, checkedBlock: 200, lastCheckedAt: NOW });
    expect(patch).not.toHaveProperty("owner");
  });

  it("writes a value that became absent as null", () => {
    expect(nextWatchState(state({ implementation: IMPL_A }), observation({ implementation: ok(null) }), NOW)).toEqual({
      implementation: null,
      checkedBlock: 200,
      lastCheckedAt: NOW,
    });
    expect(nextWatchState(state(), observation({ owner: ok(null) }), NOW)).toEqual({ owner: null, checkedBlock: 200, lastCheckedAt: NOW });
  });

  it("writes a supply decrease too: the state follows the chain even where no alert does", () => {
    expect(nextWatchState(state({ totalSupply: 100n }), observation({ totalSupply: ok(99n) }), NOW)).toEqual({
      totalSupply: 99n,
      checkedBlock: 200,
      lastCheckedAt: NOW,
    });
  });

  it("replaces the pool and its depth when the deepest pool changed", () => {
    expect(nextWatchState(state(), observation({ pool: ok({ id: POOL_B.toUpperCase().replace("0X", "0x"), depth: 5n }) }), NOW)).toEqual({
      bestPool: POOL_B,
      bestPoolDepth: 5n,
      checkedBlock: 200,
      lastCheckedAt: NOW,
    });
  });

  it("writes only the depth when the same pool's depth moved, and clears both when the pool is gone", () => {
    expect(nextWatchState(state(), observation({ pool: ok({ id: POOL_A, depth: 5n }) }), NOW)).toEqual({
      bestPoolDepth: 5n,
      checkedBlock: 200,
      lastCheckedAt: NOW,
    });
    expect(nextWatchState(state(), observation({ pool: ok(null) }), NOW)).toEqual({
      bestPool: null,
      bestPoolDepth: null,
      checkedBlock: 200,
      lastCheckedAt: NOW,
    });
    expect(nextWatchState(state({ bestPool: null, bestPoolDepth: null }), observation({ pool: ok(null) }), NOW)).toBeNull();
  });
});

describe("watchStatePatchToDoc", () => {
  it("turns the amounts into decimal strings and leaves the rest", () => {
    expect(watchStatePatchToDoc({ owner: OWNER_B, totalSupply: 5n, bestPoolDepth: null, checkedBlock: 200, lastCheckedAt: NOW })).toEqual({
      owner: OWNER_B,
      totalSupply: "5",
      bestPoolDepth: null,
      checkedBlock: 200,
      lastCheckedAt: NOW,
    });
    const doc = watchStatePatchToDoc({ paused: true, checkedBlock: 200, lastCheckedAt: NOW });
    expect(doc).toEqual({ paused: true, checkedBlock: 200, lastCheckedAt: NOW });
    expect(doc).not.toHaveProperty("totalSupply");
  });
});

// Property tests: whatever the state and the observation, the rules keep these promises.
describe("diffWatchState and nextWatchState: properties", () => {
  const hex40 = fc.stringMatching(/^[0-9a-f]{40}$/).map((h) => `0x${h}` as Address);
  const address = fc.oneof(hex40, fc.constantFrom(...BURN_ADDRESSES.map((a) => a.toLowerCase() as Address)));
  const amount = fc.bigInt({ min: 0n, max: 2n ** 128n });
  const read = <T>(value: fc.Arbitrary<T>): fc.Arbitrary<Read<T>> =>
    fc.oneof(fc.record({ ok: fc.constant(true as const), value }), fc.constant(unread as Read<T>));
  // A pool and its depth are stored together or not at all (nextWatchState writes both on first sight).
  const storedState = fc.record({
    owner: fc.option(address, { nil: null }),
    totalSupply: fc.option(amount, { nil: null }),
    paused: fc.option(fc.boolean(), { nil: null }),
    implementation: fc.option(hex40, { nil: null }),
    pool: fc.option(fc.record({ id: hex40, depth: amount }), { nil: null }),
    checkedBlock: fc.integer({ min: 1, max: 1_000_000 }),
  }).map(({ pool, ...rest }) => state({ ...rest, bestPool: pool?.id ?? null, bestPoolDepth: pool?.depth ?? null }));
  const observed = fc.record({
    block: fc.integer({ min: 1, max: 2_000_000 }),
    owner: read(fc.option(address, { nil: null })),
    totalSupply: read(fc.option(amount, { nil: null })),
    paused: read(fc.option(fc.boolean(), { nil: null })),
    implementation: read(fc.option(hex40, { nil: null })),
    pool: read(fc.option(fc.record({ id: hex40, depth: amount }), { nil: null })),
  }).map((o) => observation(o));

  /** The observation that reads the stored state back exactly. */
  const same = (s: WatchStateRecord, block: number): WatchObservation =>
    observation({
      block,
      owner: ok(s.owner),
      totalSupply: ok(s.totalSupply),
      paused: ok(s.paused),
      implementation: ok(s.implementation),
      pool: ok(s.bestPool === null || s.bestPoolDepth === null ? null : { id: s.bestPool, depth: s.bestPoolDepth }),
    });

  it("alerts nothing and writes nothing when the observation matches the stored state", () => {
    fc.assert(
      fc.property(storedState, (s) => {
        expect(diffWatchState(s, same(s, s.checkedBlock + 1))).toEqual([]);
        expect(nextWatchState(s, same(s, s.checkedBlock + 1), NOW)).toBeNull();
      }),
    );
  });

  it("alerts nothing and writes nothing when every field is unread", () => {
    const allUnread = observation({ block: 10_000_000, owner: unread, totalSupply: unread, paused: unread, implementation: unread, pool: unread });
    fc.assert(
      fc.property(storedState, (s) => {
        expect(diffWatchState(s, allUnread)).toEqual([]);
        expect(nextWatchState(s, allUnread, NOW)).toBeNull();
      }),
    );
  });

  it("alerts nothing on first sight", () => {
    fc.assert(
      fc.property(observed, (o) => {
        expect(diffWatchState(null, o)).toEqual([]);
      }),
    );
  });

  const FIELD_KINDS: Record<"owner" | "totalSupply" | "paused" | "implementation" | "pool", AlertKind[]> = {
    owner: ["owner_changed"],
    totalSupply: ["supply_increased"],
    paused: ["paused", "unpaused"],
    implementation: ["implementation_changed"],
    pool: ["liquidity_dropped"],
  };

  it("raises at most one alert, of that field's kind, when a single field differs", () => {
    fc.assert(
      fc.property(storedState, observed, fc.constantFrom(...(Object.keys(FIELD_KINDS) as (keyof typeof FIELD_KINDS)[])), (s, o, field) => {
        const obs = { ...same(s, s.checkedBlock + 1), [field]: o[field] };
        const drafts = diffWatchState(s, obs);
        expect(drafts.length).toBeLessThanOrEqual(1);
        for (const draft of drafts) expect(FIELD_KINDS[field]).toContain(draft.kind);
      }),
    );
  });

  it("never alerts for a block at or before the stored one, and never writes for it either", () => {
    fc.assert(
      fc.property(storedState, observed, (s, o) => {
        const obs = { ...o, block: Math.min(o.block, s.checkedBlock) };
        expect(diffWatchState(s, obs)).toEqual([]);
        expect(nextWatchState(s, obs, NOW)).toBeNull();
      }),
    );
  });

  it("never alerts on a field that was not read, and never writes it", () => {
    fc.assert(
      fc.property(storedState, observed, fc.constantFrom(...(Object.keys(FIELD_KINDS) as (keyof typeof FIELD_KINDS)[])), (s, o, field) => {
        const obs = { ...o, block: s.checkedBlock + 1, [field]: unread };
        for (const draft of diffWatchState(s, obs)) expect(FIELD_KINDS[field]).not.toContain(draft.kind);
        const patch = nextWatchState(s, obs, NOW) ?? {};
        for (const key of field === "pool" ? ["bestPool", "bestPoolDepth"] : [field]) expect(patch).not.toHaveProperty(key);
      }),
    );
  });

  it("writes a patch that, applied, reads back as what was observed, so the next identical check is quiet", () => {
    fc.assert(
      fc.property(storedState, observed, (s, o) => {
        const obs = { ...o, block: s.checkedBlock + 1 };
        const patch = nextWatchState(s, obs, NOW);
        const next: WatchStateRecord = { ...s, ...(patch ?? {}) };
        if (patch) expect(patch.checkedBlock).toBe(obs.block);
        // What was read is now stored; the same reads again, a block later, change nothing.
        const again = { ...obs, block: obs.block + 1 };
        const quiet = nextWatchState(next, again, NOW);
        expect(quiet).toBeNull();
        expect(diffWatchState(next, again)).toEqual([]);
      }),
    );
  });

  it("every draft carries the observation's block and label", () => {
    fc.assert(
      fc.property(storedState, observed, (s, o) => {
        for (const draft of diffWatchState(s, o)) {
          expect(draft.block).toBe(o.block);
          expect(draft.detail).toMatchObject(o.label);
        }
      }),
    );
  });
});

describe("sanitizeSymbol", () => {
  it("keeps a plain symbol", () => {
    expect(sanitizeSymbol("DUKE")).toBe("DUKE");
    expect(sanitizeSymbol("wETH 2")).toBe("wETH 2");
  });

  it("is null for nothing", () => {
    expect(sanitizeSymbol(null)).toBeNull();
    expect(sanitizeSymbol(undefined)).toBeNull();
    expect(sanitizeSymbol("")).toBeNull();
    expect(sanitizeSymbol("   ")).toBeNull();
    expect(sanitizeSymbol("‮​\u0000")).toBeNull();
  });

  it("strips a right-to-left override and the other direction-flipping characters", () => {
    expect(sanitizeSymbol("USDC‮‭")).toBe("USDC");
    expect(sanitizeSymbol("‫USDC‬")).toBe("USDC");
    expect(sanitizeSymbol("US⁦DC⁩")).toBe("USDC");
  });

  it("strips zero-width and other invisible characters", () => {
    expect(sanitizeSymbol("US​DC‍﻿")).toBe("USDC");
    expect(sanitizeSymbol("US­DC")).toBe("USDC");
  });

  it("strips the letters that draw nothing: Hangul fillers, the Braille blank, the halfwidth filler", () => {
    expect(sanitizeSymbol("\u3164\u3164")).toBeNull();
    expect(sanitizeSymbol("\u115f\u1160\u2800\uffa0")).toBeNull();
    expect(sanitizeSymbol("US\u3164DC\u2800")).toBe("USDC");
  });

  it("strips control characters and newlines, and collapses whitespace", () => {
    expect(sanitizeSymbol("US\nDC")).toBe("USDC");
    expect(sanitizeSymbol("US \n\t DC\r\n")).toBe("US DC");
    expect(sanitizeSymbol("\u0007US\u001bDC")).toBe("USDC");
    expect(sanitizeSymbol("US DC ")).toBe("USDC");
  });

  it("folds compatibility forms", () => {
    expect(sanitizeSymbol("ＵＳＤＣ")).toBe("USDC");
    expect(sanitizeSymbol("ＤＵＫＥ")).toBe("DUKE");
  });

  it("cuts to sixteen code points, counting a surrogate pair as one", () => {
    expect(sanitizeSymbol("https://evil.example/claim-your-airdrop-now-at-this-link-here")).toBe("https://evil.exa");
    expect(sanitizeSymbol("https://evil.example/claim-your-airdrop-now-at-this-link-here")).toHaveLength(16);
    expect(sanitizeSymbol("😀".repeat(20))).toBe("😀".repeat(16));
    expect(sanitizeSymbol("abcdefghijklmno pqr")).toBe("abcdefghijklmno");
  });

  it("strips before it cuts: sixteen invisible characters do not use up the sixteen", () => {
    expect(sanitizeSymbol("\u200b".repeat(16) + "DUKE")).toBe("DUKE");
    expect(sanitizeSymbol("\u202e".repeat(20) + "https://evil.example/claim")).toBe("https://evil.exa");
  });
});

describe("displaySymbol", () => {
  it("is the sanitised symbol when it is plain", () => {
    expect(displaySymbol("DUKE")).toBe("DUKE");
    expect(displaySymbol("wETH 2")).toBe("wETH 2");
    expect(displaySymbol("DUKE_v2-beta")).toBe("DUKE_v2-beta");
    expect(displaySymbol("ＤＵＫＥ‮")).toBe("DUKE");
    expect(displaySymbol("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnop");
    expect(displaySymbol("USDC2")).toBe("USDC2");
    expect(displaySymbol("X100000")).toBe("X100000");
    expect(displaySymbol("A123 456")).toBe("A123 456");
  });

  it("is null for nothing, and for a symbol that is not plain", () => {
    expect(displaySymbol(null)).toBeNull();
    expect(displaySymbol(undefined)).toBeNull();
    expect(displaySymbol("")).toBeNull();
    expect(displaySymbol("‮")).toBeNull();
    for (const hostile of ["t.me/x", "example.com", "@someone", "/start", "#airdrop", "$DUKE", "DUKE.", "DUKE:", "DUKE!", "a@b", "4155551234", "1-800-555", "😀", "DUKE 😀"]) {
      expect(displaySymbol(hostile), hostile).toBeNull();
    }
  });

  it("is null for a phone number beside a letter: a run of seven or more digits, with or without separators", () => {
    for (const phone of ["+1 415 555 0100", "A4155550100", "x1234567", "DUKE 4155550100", "DUKE 555-0100-1", "A 415 555 0100", "A415_555_0100"]) {
      expect(displaySymbol(phone), phone).toBeNull();
    }
    // Two separators in a row break the run: six digits and six digits are not one number.
    expect(displaySymbol("A123456_-123456")).toBe("A123456_-123456");
  });
});

describe("short and formatTokenUnits", () => {
  it("shows six characters, an ellipsis and four", () => {
    expect(short("0x1234567890abcdef1234567890abcdef1234abcd")).toBe("0x1234…abcd");
  });

  it("groups whole units and truncates to four fraction digits", () => {
    expect(formatTokenUnits(1_234_567n * 10n ** 18n, 18)).toBe("1,234,567");
    expect(formatTokenUnits(1_234_567n * 10n ** 18n + 123_456_789n * 10n ** 9n, 18)).toBe("1,234,567.1234");
    expect(formatTokenUnits(5n * 10n ** 17n, 18)).toBe("0.5");
    expect(formatTokenUnits(1n, 18)).toBe("0");
    expect(formatTokenUnits(1_000_000n, 6)).toBe("1");
    expect(formatTokenUnits(42n, 0)).toBe("42");
  });
});

describe("alertText", () => {
  const detail = (over: Partial<AlertDetail> = {}): AlertDetail => ({
    symbol: "DUKE",
    decimals: 18,
    from: null,
    to: null,
    quote: "USDC",
    pool: null,
    renounced: false,
    pct: null,
    ...over,
  });
  const text = (kind: AlertKind, over: Partial<AlertDetail> = {}, block = 1_234_567) =>
    alertText({ kind, token: TOKEN, network: "mainnet", block, detail: detail(over) });
  const T = "DUKE (0x8f3a…913c)";
  const FROM = "0x1234567890abcdef1234567890abcdef1234abcd";
  const TO = `0x5678${"0".repeat(32)}ef01`;

  it("links to the token on the network's explorer", () => {
    expect(text("paused").link).toBe(`https://explorer.arc.io/token/${TOKEN}`);
    expect(alertText({ kind: "paused", token: TOKEN, network: "testnet", block: 1, detail: detail() }).link).toBe(
      `https://explorer.testnet.arc.io/token/${TOKEN}`,
    );
  });

  it("owner changed", () => {
    expect(text("owner_changed", { from: FROM, to: TO }).text).toBe(`${T}: owner changed from 0x1234…abcd to 0x5678…ef01 at block 1,234,567`);
  });

  it("ownership renounced", () => {
    expect(text("owner_changed", { from: FROM, to: DEAD.toLowerCase(), renounced: true }).text).toBe(
      `${T}: ownership renounced, owner changed from 0x1234…abcd to 0x0000…dead at block 1,234,567`,
    );
  });

  it("total supply increased, in whole and fraction units when the decimals are known", () => {
    expect(text("supply_increased", { from: (1_000_000n * 10n ** 18n).toString(), to: (1_500_000n * 10n ** 18n + 5n * 10n ** 17n).toString() }).text).toBe(
      `${T}: total supply increased from 1,000,000 to 1,500,000.5 at block 1,234,567`,
    );
  });

  it("total supply increased, in raw units when the decimals are unknown", () => {
    expect(text("supply_increased", { decimals: null, from: "1000000", to: "2500000" }).text).toBe(
      `${T}: total supply increased from 1,000,000 raw units to 2,500,000 raw units at block 1,234,567`,
    );
  });

  it("paused and unpaused", () => {
    expect(text("paused").text).toBe(`${T}: paused at block 1,234,567`);
    expect(text("unpaused").text).toBe(`${T}: unpaused at block 1,234,567`);
  });

  it("implementation changed, with none for no implementation", () => {
    expect(text("implementation_changed", { from: FROM, to: TO }).text).toBe(`${T}: implementation changed from 0x1234…abcd to 0x5678…ef01 at block 1,234,567`);
    expect(text("implementation_changed", { from: null, to: TO }).text).toBe(`${T}: implementation changed from none to 0x5678…ef01 at block 1,234,567`);
    expect(text("implementation_changed", { from: FROM, to: null }).text).toBe(`${T}: implementation changed from 0x1234…abcd to none at block 1,234,567`);
  });

  it("liquidity dropped, in whole quote units", () => {
    expect(text("liquidity_dropped", { from: "10000000000", to: "6999999999", quote: "USDC", pool: POOL_A, pct: 30 }).text).toBe(
      `${T}: deepest pool's USDC fell from 10,000 to 6,999 (30% lower) at block 1,234,567`,
    );
    expect(text("liquidity_dropped", { from: "1666666666", to: "1166666666", quote: "EURC", pool: POOL_A, pct: 30 }).text).toBe(
      `${T}: deepest pool's EURC fell from 1,666 to 1,166 (30% lower) at block 1,234,567`,
    );
  });

  it("liquidity dropped with no quote or percentage: the fallbacks, pinned", () => {
    expect(text("liquidity_dropped", { from: "10000000000", to: "6999999999", quote: null, pool: POOL_A, pct: 30 }).text).toBe(
      `${T}: deepest pool's liquidity fell from 10,000 to 6,999 (30% lower) at block 1,234,567`,
    );
    expect(text("liquidity_dropped", { from: "10000000000", to: "6999999999", quote: "USDC", pool: POOL_A, pct: null }).text).toBe(
      `${T}: deepest pool's USDC fell from 10,000 to 6,999 (0% lower) at block 1,234,567`,
    );
  });

  it("lock expiring: the kind's name as words, until its rule exists", () => {
    expect(text("lock_expiring").text).toBe(`${T}: lock expiring at block 1,234,567`);
  });

  it("shows the short address alone when there is no symbol, or none survives sanitising", () => {
    expect(text("paused", { symbol: null }).text).toBe("0x8f3a…913c: paused at block 1,234,567");
    expect(text("paused", { symbol: "‮\n" }).text).toBe("0x8f3a…913c: paused at block 1,234,567");
  });

  it("sanitises the symbol: a direction override and a newline never reach the message", () => {
    expect(text("paused", { symbol: "DUKE‮" }).text).toBe(`${T}: paused at block 1,234,567`);
    expect(text("paused", { symbol: "DU\nKE" }).text).toBe(`${T}: paused at block 1,234,567`);
  });

  it("shows a plain symbol: letters, digits, spaces, underscores and hyphens", () => {
    expect(text("paused", { symbol: "wETH 2" }).text).toBe("wETH 2 (0x8f3a…913c): paused at block 1,234,567");
    expect(text("paused", { symbol: "DUKE_v2-beta" }).text).toBe("DUKE_v2-beta (0x8f3a…913c): paused at block 1,234,567");
    expect(text("paused", { symbol: "1INCH" }).text).toBe("1INCH (0x8f3a…913c): paused at block 1,234,567");
    expect(text("paused", { symbol: "ÉTOILE" }).text).toBe("ÉTOILE (0x8f3a…913c): paused at block 1,234,567");
  });

  it("leaves out a symbol Telegram would make tappable in plain text: a URL, a domain, a mention, a command, a tag, a phone number", () => {
    const plain = "0x8f3a…913c: paused at block 1,234,567";
    expect(text("paused", { symbol: "https://evil.example/claim-your-airdrop-now-at-this-link-here" }).text).toBe(plain);
    expect(text("paused", { symbol: "t.me/x" }).text).toBe(plain);
    expect(text("paused", { symbol: "example.com" }).text).toBe(plain);
    expect(text("paused", { symbol: "@someone" }).text).toBe(plain);
    expect(text("paused", { symbol: "/start" }).text).toBe(plain);
    expect(text("paused", { symbol: "#airdrop" }).text).toBe(plain);
    expect(text("paused", { symbol: "$DUKE" }).text).toBe(plain);
    expect(text("paused", { symbol: "+1 415 555 0100" }).text).toBe(plain);
    expect(text("paused", { symbol: "4155551234" }).text).toBe(plain);
    expect(text("paused", { symbol: "A4155550100" }).text).toBe(plain);
    expect(text("paused", { symbol: "x1234567" }).text).toBe(plain);
    expect(text("paused", { symbol: "DUKE" }).text).toBe("DUKE (0x8f3a…913c): paused at block 1,234,567");
    expect(text("paused", { symbol: "USDC2" }).text).toBe("USDC2 (0x8f3a…913c): paused at block 1,234,567");
    expect(text("paused", { symbol: "DUKE:" }).text).toBe(plain);
    expect(text("paused", { symbol: "😀" }).text).toBe(plain);
  });

  it("groups the block number", () => {
    expect(text("paused", {}, 7).text).toBe(`${T}: paused at block 7`);
    expect(text("paused", {}, 999).text).toBe(`${T}: paused at block 999`);
    expect(text("paused", {}, 1000).text).toBe(`${T}: paused at block 1,000`);
  });

  it("stays well under Telegram's 4,096 characters at the largest values", () => {
    const max = (2n ** 256n - 1n).toString();
    const { text: longest } = text("supply_increased", { decimals: null, from: max, to: max, symbol: "😀".repeat(40) });
    expect(longest.length).toBeLessThan(400);
  });
});

describe("isBurnAddress", () => {
  it("knows both burn addresses in any case", () => {
    expect(isBurnAddress(ZERO)).toBe(true);
    expect(isBurnAddress(DEAD)).toBe(true);
    expect(isBurnAddress(DEAD.toLowerCase())).toBe(true);
    expect(isBurnAddress(OWNER_A)).toBe(false);
  });
});
