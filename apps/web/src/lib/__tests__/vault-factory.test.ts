import { describe, expect, it } from "vitest";
import { ARCOS } from "@arcos/chain";
import { contractAddress } from "@/apps/registry";
import { vaultFactoryOf } from "../vault-factory";

const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("vaultFactoryOf", () => {
  it("is set on testnet (R1 is deployed there) and null on mainnet", () => {
    expect(vaultFactoryOf("mainnet")).toBeNull();
    expect(vaultFactoryOf("testnet")).toBe("0x18A3c9ca7D7800a5dDA376bDFa4c0AA187675A23");
  });

  it("reads the address the way the registry decides Vault is live, so the two never disagree", () => {
    for (const contracts of [null, {}, { vaultFactory: null }, { vaultFactory: "0x1234" }, { vaultFactory: 7 }, { vaultFactory: `0x${"0".repeat(40)}` }, { vaultFactory: ADDRESS }]) {
      expect(vaultFactoryOf("testnet", contracts), JSON.stringify(contracts)).toBe(contractAddress(contracts, "vaultFactory"));
    }
    expect(vaultFactoryOf("testnet", undefined)).toBe(contractAddress(ARCOS.testnet, "vaultFactory")); // undefined: the network's own
    expect(vaultFactoryOf("testnet", { ...ARCOS.testnet, vaultFactory: ADDRESS })).toBe(ADDRESS);
  });
});
