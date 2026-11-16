import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { AERODROME, DEX, POSITION_MANAGERS, UNISWAP_V4 } from "../index";

describe("POSITION_MANAGERS", () => {
  it("names Uniswap v3's manager on mainnet only, and v4's on both networks", () => {
    expect(POSITION_MANAGERS.mainnet.map((m) => m.name)).toEqual(["Uniswap v3", "Uniswap v4"]);
    expect(POSITION_MANAGERS.testnet.map((m) => m.name)).toEqual(["Uniswap v4"]);
    expect(POSITION_MANAGERS.mainnet[0]?.address).toBe("0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377");
    for (const network of ["mainnet", "testnet"] as const) {
      expect(POSITION_MANAGERS[network].find((m) => m.name === "Uniswap v4")?.address).toBe(UNISWAP_V4.positionManager);
    }
  });

  it("lists only networks' real DEXes: no v3 manager where the network has no v3", () => {
    expect(DEX.mainnet?.v3Factory).toBeDefined();
    expect(DEX.testnet?.v3Factory).toBeUndefined();
  });

  it("gives every address checksummed, non-zero and once per network", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      const list = POSITION_MANAGERS[network];
      for (const m of list) {
        expect(getAddress(m.address), m.name).toBe(m.address);
        expect(BigInt(m.address), m.name).not.toBe(0n);
      }
      expect(new Set(list.map((m) => m.address.toLowerCase())).size).toBe(list.length);
    }
  });

  it("leaves Aerodrome's manager out: the vault contracts take Uniswap v3 and v4 positions only", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      expect(POSITION_MANAGERS[network].some((m) => m.address.toLowerCase() === AERODROME.positionManager.toLowerCase())).toBe(false);
    }
  });
});
