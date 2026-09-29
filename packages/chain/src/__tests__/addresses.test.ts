import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import { AERODROME, ARCOS, BURN_ADDRESSES, DEX, EURC, KNOWN_LOCKERS, MULTICALL3, UNISWAP_V4, USDC, type DexConfig } from "../addresses";
import { checkArcosAddresses } from "../addressSanity";
import { CHAINS } from "../chains";

const inDex = (dex: DexConfig | null) =>
  dex
    ? [
        ...(dex.v2Factory ? [dex.v2Factory] : []),
        ...(dex.v3Factory ? [dex.v3Factory] : []),
        ...dex.quoteTokens.map((q) => q.address),
        ...(dex.v4 ? Object.values(dex.v4) : []),
        ...(dex.aero ? [dex.aero.clFactory, dex.aero.positionManager] : []),
      ]
    : [];

const all = [
  USDC, MULTICALL3, EURC.mainnet, EURC.testnet, ...BURN_ADDRESSES, ...KNOWN_LOCKERS.mainnet, ...KNOWN_LOCKERS.testnet,
  ...inDex(DEX.mainnet), ...inDex(DEX.testnet),
  ...Object.values(ARCOS).flatMap((c) => (c ? Object.values(c) : [])),
];

describe("addresses", () => {
  it("are all well-formed", () => {
    for (const a of all) expect(isAddress(a, { strict: false }), a).toBe(true);
  });
  it("quotes liquidity against USDC first, on both networks", () => {
    expect(DEX.mainnet?.quoteTokens[0]).toEqual({ address: USDC, symbol: "USDC" });
    expect(DEX.testnet?.quoteTokens[0]).toEqual({ address: USDC, symbol: "USDC" });
  });
  it("has Uniswap v4 at the four verified addresses, checksummed, the same on both networks", () => {
    expect(UNISWAP_V4).toEqual({
      poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      positionManager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B",
      stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
      quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
    });
    for (const a of Object.values(UNISWAP_V4)) expect(getAddress(a), a).toBe(a);
    expect(new Set(Object.values(UNISWAP_V4).map((a) => a.toLowerCase())).size).toBe(4);
    expect(DEX.mainnet?.v4).toBe(UNISWAP_V4);
    expect(DEX.testnet?.v4).toBe(UNISWAP_V4);
  });
  it("has Aerodrome Slipstream on mainnet only, with the factory's own tick spacings", () => {
    expect(AERODROME.clFactory).toBe("0xb89Df768aF2CFE637ceB352c587Fe8edAf491d03");
    expect(AERODROME.positionManager).toBe("0xc84bB45D43CD25D02b83B4C085eaA4e08da8f473");
    for (const a of [AERODROME.clFactory, AERODROME.positionManager]) expect(getAddress(a), a).toBe(a);
    expect(AERODROME.tickSpacings).toEqual([1, 10, 50, 100, 200, 2000]);
    expect(DEX.mainnet?.aero).toBe(AERODROME);
    expect(DEX.testnet?.aero).toBeUndefined();
  });
  it("keeps Uniswap v2 and v3 on mainnet only: testnet has neither", () => {
    expect(DEX.mainnet?.v2Factory).toBeDefined();
    expect(DEX.mainnet?.v3Factory).toBeDefined();
    expect(DEX.mainnet?.v3FeeTiers).toEqual([100, 500, 3000, 10000]);
    expect(DEX.testnet).toEqual({ quoteTokens: [{ address: USDC, symbol: "USDC" }, { address: EURC.testnet, symbol: "EURC" }], v4: UNISWAP_V4 });
  });
  it("names the Multicall3 both networks' chain definitions name", () => {
    expect(CHAINS.mainnet.contracts?.multicall3?.address).toBe(MULTICALL3);
    expect(CHAINS.testnet.contracts?.multicall3?.address).toBe(MULTICALL3);
  });
  it("wires a deployment that passes the shape check on both networks", () => {
    expect(checkArcosAddresses(ARCOS.testnet)).toEqual({ status: "ok" });
    expect(checkArcosAddresses(ARCOS.mainnet)).toEqual({ status: "ok" });
  });
});
