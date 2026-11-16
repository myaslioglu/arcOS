import { describe, expect, it } from "vitest";
import { addWallet, addedKey, readAdded } from "../added";

const W = "0x1111111111111111111111111111111111111111";
const W2 = "0x3333333333333333333333333333333333333333";
const T = "0x2222222222222222222222222222222222222222";
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("added wallets", () => {
  it("keys by network and lower-cased address", () => {
    expect(addedKey("testnet", "0xABCDEF0000000000000000000000000000000001")).toBe("arcos.vesting.added.testnet.0xabcdef0000000000000000000000000000000001");
  });
  it("saves and reads back the wallet alone, once: its token comes from the factory's tokenOf", () => {
    const s = memory();
    expect(readAdded("k", s)).toEqual([]);
    addWallet("k", W, s);
    expect(readAdded("k", s)).toEqual([{ wallet: W }]);
    addWallet("k", W, s);
    addWallet("k", W2, s);
    expect(readAdded("k", s)).toEqual([{ wallet: W }, { wallet: W2 }]);
  });
  it("reads an entry saved with a token before, for its wallet alone", () => {
    const s = memory();
    s.setItem("k", JSON.stringify([{ wallet: W, token: T }, { wallet: W.toUpperCase().replace("0X", "0x"), token: T }]));
    expect(readAdded("k", s)).toEqual([{ wallet: W }]);
  });
  it("drops malformed entries and survives bad JSON, a missing store and a store that throws", () => {
    const s = memory();
    s.setItem("k", JSON.stringify([{ wallet: "nope" }, { wallet: W }, null, 5, { token: T }]));
    expect(readAdded("k", s)).toEqual([{ wallet: W }]);
    s.setItem("k", "{not json");
    expect(readAdded("k", s)).toEqual([]);
    expect(readAdded("k", null)).toEqual([]);
    expect(addWallet("k", W, null)).toEqual([{ wallet: W }]);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(readAdded("k", broken)).toEqual([]);
    expect(addWallet("k", W, broken)).toEqual([{ wallet: W }]);
  });
});
