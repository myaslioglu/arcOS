import { describe, expect, it } from "vitest";
import { isAddress } from "viem";
import { ARCOS, BURN_ADDRESSES, DEX, EURC, KNOWN_LOCKERS, USDC, type Address } from "../addresses";
import { checkArcosAddresses } from "../addressSanity";

const all = [
  USDC, EURC.mainnet, EURC.testnet, ...BURN_ADDRESSES, ...KNOWN_LOCKERS.mainnet, ...KNOWN_LOCKERS.testnet,
  ...(DEX.mainnet ? [DEX.mainnet.v2Factory, DEX.mainnet.v3Factory, ...DEX.mainnet.quoteTokens.map((q) => q.address)] : []),
  ...Object.values(ARCOS).flatMap((c) => (c ? Object.values(c).filter((a): a is Address => a != null) : [])),
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
});
