import type { Address } from "@arcos/chain";
import { describe, expect, it } from "vitest";
import { poolFromDoc, poolToDoc, tokenFromDoc, tokenToDoc, watchStateFromDoc, watchStateToDoc } from "../converters";
import type { PoolRecord, TokenRecord, WatchStateRecord } from "../docs";
import { refusal } from "./helpers/refusal";
import { at } from "./helpers/timestamp";

const TOKEN_MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as Address;
const TOKEN = "0xabcdef0123456789abcdef0123456789abcdef01" as Address;
const CREATOR_MIXED = "0x0102030405060708090A0b0c0d0e0f1011121314" as Address;
const CREATOR = "0x0102030405060708090a0b0c0d0e0f1011121314" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL32 = `0x${"ab".repeat(32)}`;
const POOL32_UPPER = `0x${"AB".repeat(32)}`;
const BIG = 123_456_789_012_345_678_901_234n;

const fullToken = (): TokenRecord => ({
  network: "mainnet",
  address: TOKEN_MIXED,
  name: "Duke",
  symbol: "DUKE",
  decimals: 6,
  totalSupply: BIG,
  source: "v3",
  creator: CREATOR_MIXED,
  firstBlock: 23_400_000,
  firstSeen: at(1_790_000_000_000),
  bestPool: { id: POOL32_UPPER, version: "v4", depthUsdc: 2_500_000_000n },
  report: { passed: 6, total: 8, counts: { pass: 6, warn: 1, fail: 0, unknown: 1 }, block: 23_400_100, at: at(1_790_000_100_000) },
  radar: { liquid: true, passing: true },
  inspect: { state: "done", priority: 1, attempts: 1, queuedAt: null },
  launchpad: "factory",
});

const bareToken = (): TokenRecord => ({
  network: "testnet",
  address: TOKEN,
  name: null,
  symbol: null,
  decimals: null,
  totalSupply: null,
  source: "factory",
  creator: null,
  firstBlock: 1,
  firstSeen: at(1_790_000_000_000),
  bestPool: null,
  report: null,
  radar: { liquid: false, passing: false },
  inspect: { state: "queued", priority: 0, attempts: 0, queuedAt: at(1_790_000_000_000) },
  launchpad: null,
});

describe("tokenToDoc", () => {
  it("writes amounts as decimal strings and every address in lowercase", () => {
    const doc = tokenToDoc(fullToken());
    expect(doc.totalSupply).toBe("123456789012345678901234");
    expect(doc.bestPool).toEqual({ id: POOL32, version: "v4", depthUsdc: "2500000000" });
    expect(doc.address).toBe(TOKEN);
    expect(doc.creator).toBe(CREATOR);
  });

  it("passes the Timestamps through untouched: the caller supplies them", () => {
    const token = fullToken();
    const doc = tokenToDoc(token);
    expect(doc.firstSeen).toBe(token.firstSeen);
    expect(doc.report?.at).toBe(token.report?.at);
  });

  it("keeps a missing value as null, never undefined", () => {
    const doc = tokenToDoc(bareToken());
    expect(doc).toMatchObject({ totalSupply: null, creator: null, bestPool: null, report: null, launchpad: null });
    expect(Object.values(doc)).not.toContain(undefined);
  });

  it("writes only the fields of the doc, so a stray property never reaches Firestore", () => {
    const stray = { ...fullToken(), extra: "x", radar: { liquid: true, passing: false, sneaky: 1 } } as TokenRecord;
    const doc = tokenToDoc(stray);
    expect(Object.keys(doc).sort()).toEqual(
      [
        "address", "bestPool", "creator", "decimals", "firstBlock", "firstSeen", "inspect", "launchpad", "name",
        "network", "radar", "report", "source", "symbol", "totalSupply",
      ].sort(),
    );
    expect(Object.keys(doc.radar)).toEqual(["liquid", "passing"]);
  });

  it("refuses a bad network, address, pool id or amount, by code", () => {
    expect(refusal(() => tokenToDoc({ ...fullToken(), network: "other" as never })).code).toBe("network");
    expect(refusal(() => tokenToDoc({ ...fullToken(), address: "0x1" as Address })).code).toBe("address");
    expect(refusal(() => tokenToDoc({ ...fullToken(), creator: "nope" as Address })).code).toBe("address");
    expect(refusal(() => tokenToDoc({ ...fullToken(), totalSupply: -1n })).code).toBe("amount");
    const bestPool = { id: "0x12", version: "v2" as const, depthUsdc: 1n };
    expect(refusal(() => tokenToDoc({ ...fullToken(), bestPool })).code).toBe("pool-id");
  });
});

describe("tokenFromDoc", () => {
  it("reads amounts back as bigint", () => {
    expect(tokenFromDoc(tokenToDoc(fullToken())).totalSupply).toBe(BIG);
    expect(tokenFromDoc(tokenToDoc(fullToken())).bestPool?.depthUsdc).toBe(2_500_000_000n);
  });

  it("gives back what was written, normalised", () => {
    const written = fullToken();
    const normalised = { ...written, address: TOKEN, creator: CREATOR, bestPool: { id: POOL32, version: "v4", depthUsdc: 2_500_000_000n } };
    expect(tokenFromDoc(tokenToDoc(written))).toEqual(normalised);
    expect(tokenFromDoc(tokenToDoc(bareToken()))).toEqual(bareToken());
  });

  it("refuses a stored amount that is not decimal digits", () => {
    const doc = { ...tokenToDoc(fullToken()), totalSupply: "1.5" };
    expect(refusal(() => tokenFromDoc(doc)).code).toBe("amount");
  });
});

const v2Pool = (): PoolRecord => ({
  network: "mainnet",
  poolId: TOKEN_MIXED,
  version: "v2",
  token: CREATOR_MIXED,
  quote: "USDC",
  fee: null,
  createdBlock: 23_000_000,
  key: null,
  depthUsdc: 1_000_000_000n,
  sampledAt: at(1_790_000_200_000),
});

const v4Pool = (): PoolRecord => ({
  network: "mainnet",
  poolId: POOL32_UPPER,
  version: "v4",
  token: TOKEN_MIXED,
  quote: "USDC-native",
  fee: 500,
  createdBlock: 23_400_000,
  key: { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: CREATOR_MIXED },
  depthUsdc: BIG,
  sampledAt: at(1_790_000_300_000),
});

describe("pools", () => {
  it("write a v2 pair with no key, an amount string and lowercase addresses", () => {
    const pool = v2Pool();
    expect(poolToDoc(pool)).toEqual({ ...pool, poolId: TOKEN, token: CREATOR, depthUsdc: "1000000000" });
    expect(poolToDoc(pool).sampledAt).toBe(pool.sampledAt);
  });

  it("write a v4 pool by its 32-byte id, with its key's addresses lowercased", () => {
    const doc = poolToDoc(v4Pool());
    expect(doc.poolId).toBe(POOL32);
    expect(doc.key).toEqual({ currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: CREATOR });
    expect(doc.depthUsdc).toBe("123456789012345678901234");
  });

  it("keep an unsampled pool's depth and time null", () => {
    const doc = poolToDoc({ ...v2Pool(), depthUsdc: null, sampledAt: null });
    expect(doc.depthUsdc).toBeNull();
    expect(doc.sampledAt).toBeNull();
  });

  it("come back as the record that was written, normalised", () => {
    expect(poolFromDoc(poolToDoc(v4Pool()))).toEqual({ ...v4Pool(), poolId: POOL32, token: TOKEN, key: { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: CREATOR } });
    expect(poolFromDoc(poolToDoc(v2Pool()))).toEqual({ ...v2Pool(), poolId: TOKEN, token: CREATOR });
  });

  it("refuse a bad pool id, a bad key address and a bad amount, by code", () => {
    expect(refusal(() => poolToDoc({ ...v2Pool(), poolId: "0x12" })).code).toBe("pool-id");
    const key = { ...v4Pool().key!, hooks: "nope" as Address };
    expect(refusal(() => poolToDoc({ ...v4Pool(), key })).code).toBe("address");
    expect(refusal(() => poolToDoc({ ...v2Pool(), depthUsdc: -5n })).code).toBe("amount");
  });
});

const firstSight = (): WatchStateRecord => ({
  network: "mainnet",
  token: TOKEN_MIXED,
  owner: null,
  totalSupply: null,
  paused: null,
  implementation: null,
  bestPool: null,
  bestPoolDepth: null,
  checkedBlock: 23_400_000,
  watchers: 1,
  lastCheckedAt: at(1_790_000_400_000),
});

const fullState = (): WatchStateRecord => ({
  ...firstSight(),
  owner: CREATOR_MIXED,
  totalSupply: BIG,
  paused: false,
  implementation: USDC,
  bestPool: POOL32_UPPER,
  bestPoolDepth: 750_000_000n,
});

describe("watch state", () => {
  it("writes a first-sight state as nulls and a full one as strings and lowercase addresses", () => {
    expect(watchStateToDoc(firstSight())).toEqual({ ...firstSight(), token: TOKEN });
    expect(watchStateToDoc(fullState())).toEqual({
      ...fullState(),
      token: TOKEN,
      owner: CREATOR,
      totalSupply: "123456789012345678901234",
      bestPool: POOL32,
      bestPoolDepth: "750000000",
    });
  });

  it("passes lastCheckedAt through untouched", () => {
    const state = fullState();
    expect(watchStateToDoc(state).lastCheckedAt).toBe(state.lastCheckedAt);
  });

  it("comes back as the record that was written, normalised", () => {
    expect(watchStateFromDoc(watchStateToDoc(fullState()))).toEqual({ ...fullState(), token: TOKEN, owner: CREATOR, bestPool: POOL32 });
    expect(watchStateFromDoc(watchStateToDoc(firstSight()))).toEqual({ ...firstSight(), token: TOKEN });
  });

  it("refuses a bad token, owner, pool or amount, by code", () => {
    expect(refusal(() => watchStateToDoc({ ...firstSight(), token: "0x1" as Address })).code).toBe("address");
    expect(refusal(() => watchStateToDoc({ ...fullState(), owner: "nope" as Address })).code).toBe("address");
    expect(refusal(() => watchStateToDoc({ ...fullState(), bestPool: "0x12" })).code).toBe("pool-id");
    expect(refusal(() => watchStateToDoc({ ...fullState(), bestPoolDepth: -1n })).code).toBe("amount");
  });
});
