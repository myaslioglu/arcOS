import { describe, expect, it } from "vitest";
import { combinePrivileges, privilegesFromAbi, privilegesFromSelectors } from "../privileges";

describe("privilegesFromSelectors", () => {
  it("recognises well-known selectors", () => {
    const found = privilegesFromSelectors(new Set(["0x40c10f19", "0x8456cb59", "0xdeadbeef"]));
    expect(found).toEqual([
      { category: "mint", signature: "mint(address,uint256)" },
      { category: "pause", signature: "pause()" },
    ]);
  });
  it("returns nothing for a plain ERC-20", () => {
    expect(privilegesFromSelectors(new Set(["0xa9059cbb", "0x70a08231"]))).toEqual([]);
  });
});

describe("privilegesFromAbi", () => {
  const fn = (name: string, stateMutability = "nonpayable") => ({ type: "function", name, stateMutability, inputs: [] });
  it("matches by name and ignores views, events and junk", () => {
    const abi = [fn("setSellTax"), fn("addToBlacklist"), fn("isBlacklisted", "view"), { type: "event", name: "Mint" }, null, 42];
    expect(privilegesFromAbi(abi)).toEqual([
      { category: "blacklist", signature: "addToBlacklist" },
      { category: "fees", signature: "setSellTax" },
    ]);
  });
});

describe("real-world coverage", () => {
  it("recognises USDT's blacklist functions by selector", () => {
    const found = privilegesFromSelectors(new Set(["0x0ecb93c0", "0xe4997dc5"]));
    expect(found.map((p) => p.signature)).toEqual(["addBlackList(address)", "removeBlackList(address)"]);
    expect(found.every((p) => p.category === "blacklist")).toBe(true);
  });

  const fn = (name: string, stateMutability = "nonpayable") => ({ type: "function", name, stateMutability, inputs: [] });
  const categoryOf = (name: string) => privilegesFromAbi([fn(name)])[0]?.category ?? null;

  it("matches the names scam-token templates actually use", () => {
    for (const name of ["safeMint", "mintTokens", "ownerMint", "adminMint", "batchMint", "issue"]) expect(categoryOf(name), name).toBe("mint");
    for (const name of ["addBlackList", "removeBlackList", "setBlacklisted", "freezeAccount", "unfreeze", "destroyBlackFunds", "setBots", "delBot", "blockAccount"]) expect(categoryOf(name), name).toBe("blacklist");
    for (const name of ["excludeFromFee", "includeInFee", "excludeFromFees", "removeAllFee", "restoreAllFee", "setMarketingFee", "updateSellFees"]) expect(categoryOf(name), name).toBe("fees");
    for (const name of ["setMaxTransactionAmount", "updateMaxTxnAmount", "updateMaxWalletAmount"]) expect(categoryOf(name), name).toBe("limits");
    for (const name of ["enableTrading", "openTrading", "startTrading", "disableTrading", "pauseTrading", "setTradingActive", "toggleTrading"]) expect(categoryOf(name), name).toBe("pause");
  });

  it("leaves harmless names alone", () => {
    for (const name of ["transfer", "approve", "transferFrom", "increaseAllowance", "renounceOwnership", "transferOwnership", "setRouter", "publicMint", "claim", "burn", "withdrawStuckTokens", "permit"]) {
      expect(categoryOf(name), name).toBeNull();
    }
  });

  it("ignores view functions whatever they are called", () => {
    expect(privilegesFromAbi([fn("isBlacklisted", "view"), fn("tradingEnabled", "view"), fn("maxTxAmount", "pure")])).toEqual([]);
  });
});

describe("combinePrivileges", () => {
  it("never lets an empty (but present) ABI array suppress the bytecode scan", () => {
    const found = combinePrivileges([], new Set(["0x40c10f19"])); // mint(address,uint256)
    expect(found).toEqual([{ category: "mint", signature: "mint(address,uint256)" }]);
  });

  it("unions ABI- and bytecode-derived findings, sorted by category", () => {
    const abi = [{ type: "function", name: "setSellTax", stateMutability: "nonpayable", inputs: [] }];
    const found = combinePrivileges(abi, new Set(["0x8456cb59"])); // pause()
    expect(found).toEqual([
      { category: "fees", signature: "setSellTax" },
      { category: "pause", signature: "pause()" },
    ]);
  });
});
