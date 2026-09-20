import { describe, expect, it } from "vitest";
import { privilegesFromAbi, privilegesFromSelectors } from "../privileges";

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
