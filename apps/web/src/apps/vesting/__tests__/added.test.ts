import { describe, expect, it } from "vitest";
import { addWallet, addedKey, readAdded, tokenCache } from "../added";

const W = "0x1111111111111111111111111111111111111111";
const T = "0x2222222222222222222222222222222222222222";
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("added wallets", () => {
  it("keys by network and lower-cased address", () => {
    expect(addedKey("testnet", "0xABCDEF0000000000000000000000000000000001")).toBe("arcos.vesting.added.testnet.0xabcdef0000000000000000000000000000000001");
  });
  it("saves, reads back and replaces by wallet", () => {
    const s = memory();
    expect(readAdded("k", s)).toEqual([]);
    addWallet("k", W, T, s);
    expect(readAdded("k", s)).toEqual([{ wallet: W, token: T }]);
    addWallet("k", W, "0x3333333333333333333333333333333333333333", s);
    expect(readAdded("k", s)).toEqual([{ wallet: W, token: "0x3333333333333333333333333333333333333333" }]);
  });
  it("drops malformed entries and survives bad JSON, a missing store and a store that throws", () => {
    const s = memory();
    s.setItem("k", JSON.stringify([{ wallet: "nope", token: T }, { wallet: W, token: T }, null, 5]));
    expect(readAdded("k", s)).toEqual([{ wallet: W, token: T }]);
    s.setItem("k", "{not json");
    expect(readAdded("k", s)).toEqual([]);
    expect(readAdded("k", null)).toEqual([]);
    expect(addWallet("k", W, T, null)).toEqual([{ wallet: W, token: T }]);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(readAdded("k", broken)).toEqual([]);
    expect(addWallet("k", W, T, broken)).toEqual([{ wallet: W, token: T }]);
  });
});

describe("tokenCache", () => {
  it("remembers a wallet's token per network, and survives a store that fails", () => {
    const s = memory();
    const c = tokenCache("testnet", s);
    expect(c.get(W)).toBeUndefined();
    c.set(W, T);
    expect(tokenCache("testnet", s).get(W.toUpperCase().replace("0X", "0x"))).toBe(T);
    expect(tokenCache("mainnet", s).get(W)).toBeUndefined();
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(tokenCache("testnet", broken).get(W)).toBeUndefined();
    expect(() => tokenCache("testnet", broken).set(W, T)).not.toThrow();
    expect(tokenCache("testnet", null).get(W)).toBeUndefined();
  });
});
