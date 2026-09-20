import { describe, expect, it } from "vitest";
import { isAddress } from "viem";
import { ARCOS, BURN_ADDRESSES, DEX, EURC, KNOWN_LOCKERS, USDC } from "../addresses";

const all = [
  USDC, EURC.mainnet, EURC.testnet, ...BURN_ADDRESSES, ...KNOWN_LOCKERS.mainnet, ...KNOWN_LOCKERS.testnet,
  ...(DEX.mainnet ? [DEX.mainnet.v2Factory, DEX.mainnet.v3Factory, ...DEX.mainnet.quoteTokens.map((q) => q.address)] : []),
  ...Object.values(ARCOS).flatMap((c) => (c ? Object.values(c) : [])),
];

describe("addresses", () => {
  it("are all well-formed", () => {
    for (const a of all) expect(isAddress(a, { strict: false }), a).toBe(true);
  });
  it("quotes liquidity against USDC first", () => {
    expect(DEX.mainnet?.quoteTokens[0]).toEqual({ address: USDC, symbol: "USDC" });
    expect(DEX.testnet).toBeNull();
  });
});
