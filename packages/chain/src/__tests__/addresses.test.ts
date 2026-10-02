import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import {
  AERODROME, ARCOS, BURN_ADDRESSES, DEX, EURC, KNOWN_LOCKERS, MULTICALL3, PERMIT2, UNISWAP_V4, UNIVERSAL_ROUTERS, USDC, type Address, type DexConfig,
} from "../addresses";
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
  ...Object.values(ARCOS).flatMap((c) => (c ? Object.values(c).filter((a): a is Address => a != null) : [])),
  PERMIT2, ...UNIVERSAL_ROUTERS.mainnet, ...UNIVERSAL_ROUTERS.testnet,
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
  it("keeps R1's contracts null until DeployR1 has run: on testnet for now, and on mainnet", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      expect(ARCOS[network]?.vaultFactory, network).toBeNull();
      expect(ARCOS[network]?.vestingFactory, network).toBeNull();
      expect(ARCOS[network]?.proPass, network).toBeNull();
    }
  });
  it("wires a deployment that passes the shape check on both networks", () => {
    expect(checkArcosAddresses(ARCOS.testnet)).toEqual({ status: "ok" });
    expect(checkArcosAddresses(ARCOS.mainnet)).toEqual({ status: "ok" });
  });
  it("names Permit2 at its canonical address, the same on both networks", () => {
    expect(PERMIT2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
  });
  it("lists both Universal Routers on mainnet, and only the one with code on testnet", () => {
    expect(UNIVERSAL_ROUTERS.mainnet).toEqual([
      "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
      "0x8702463e73f74d0b6765aBceb314Ef07aCb92650",
    ]);
    expect(UNIVERSAL_ROUTERS.testnet).toEqual(["0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1"]);
  });
});
