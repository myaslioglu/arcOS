import { beforeEach, describe, expect, it } from "vitest";
import { MAX_REMEMBERED, forgetVault, rememberVault, rememberedSnapshot, rememberedVaults, subscribeRemembered } from "../remembered";

/** A Storage held in memory, as the tests' environment has no localStorage. */
function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

const W1 = "0x7E57000000000000000000000000000000000001";
const W2 = "0x7e57000000000000000000000000000000000002";
const vault = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
let store: Storage;
beforeEach(() => {
  store = memory();
});

describe("remembered vaults", () => {
  it("keeps each vault once per network and wallet, newest last, checksummed", () => {
    rememberVault("testnet", W1, vault(1), store);
    rememberVault("testnet", W1, vault(2), store);
    rememberVault("testnet", W1.toLowerCase(), vault(1), store);
    expect(rememberedVaults("testnet", W1, store)).toEqual([vault(2), vault(1)]);
    expect(rememberedVaults("mainnet", W1, store)).toEqual([]);
    expect(rememberedVaults("testnet", W2, store)).toEqual([]);
  });

  it("forgets one, and keeps at most MAX_REMEMBERED", () => {
    for (let i = 1; i <= MAX_REMEMBERED + 3; i++) rememberVault("testnet", W1, vault(i), store);
    const list = rememberedVaults("testnet", W1, store);
    expect(list).toHaveLength(MAX_REMEMBERED);
    expect(list[0]).toBe(vault(4));
    forgetVault("testnet", W1, vault(4), store);
    expect(rememberedVaults("testnet", W1, store)).not.toContain(vault(4));
  });

  it("reads junk in storage as nothing, and keeps only addresses", () => {
    store.setItem(`arcos.vault.remembered.testnet.${W1.toLowerCase()}`, "not json");
    expect(rememberedVaults("testnet", W1, store)).toEqual([]);
    store.setItem(`arcos.vault.remembered.testnet.${W1.toLowerCase()}`, JSON.stringify([vault(9), "0x12", 7, null]));
    expect(rememberedVaults("testnet", W1, store)).toEqual([vault(9)]);
  });

  it("survives a storage that throws", () => {
    const broken = { ...memory(), getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as Storage;
    expect(rememberedVaults("testnet", W1, broken)).toEqual([]);
    expect(() => rememberVault("testnet", W1, vault(1), broken)).not.toThrow();
  });

  it("tells subscribers of a change, and hands useSyncExternalStore one snapshot until then", () => {
    let heard = 0;
    const off = subscribeRemembered(() => (heard += 1));
    const first = rememberedSnapshot("testnet", W2);
    expect(rememberedSnapshot("testnet", W2)).toBe(first);
    rememberVault("testnet", W1, vault(1), store);
    expect(heard).toBe(1);
    expect(rememberedSnapshot("testnet", W2)).not.toBe(first);
    off();
    rememberVault("testnet", W1, vault(2), store);
    expect(heard).toBe(1);
  });
});
