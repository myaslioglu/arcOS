import { describe, expect, it } from "vitest";
import { isAddress } from "viem";
import { ARCOS, BURN_ADDRESSES, DEX, EURC, KNOWN_LOCKERS, PERMIT2, UNIVERSAL_ROUTERS, USDC, type Address } from "../addresses";
import { checkArcosAddresses } from "../addressSanity";

const all = [
  USDC, EURC.mainnet, EURC.testnet, ...BURN_ADDRESSES, ...KNOWN_LOCKERS.mainnet, ...KNOWN_LOCKERS.testnet,
  ...(DEX.mainnet ? [DEX.mainnet.v2Factory, DEX.mainnet.v3Factory, ...DEX.mainnet.quoteTokens.map((q) => q.address)] : []),
  ...Object.values(ARCOS).flatMap((c) => (c ? Object.values(c).filter((a): a is Address => a != null) : [])),
  PERMIT2, ...UNIVERSAL_ROUTERS.mainnet, ...UNIVERSAL_ROUTERS.testnet,
];

describe("addresses", () => {
  it("are all well-formed", () => {
    for (const a of all) expect(isAddress(a, { strict: false }), a).toBe(true);
  });
  it("quotes liquidity against USDC first", () => {
    expect(DEX.mainnet?.quoteTokens[0]).toEqual({ address: USDC, symbol: "USDC" });
    expect(DEX.testnet).toBeNull();
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
