import { describe, expect, it } from "vitest";
import { ARCOS } from "@arcos/chain";
import { contractAddress } from "@/apps/registry";
import { vaultFactoryOf } from "../vault-factory";

const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("vaultFactoryOf", () => {
  it("is null on both networks today: no VaultFactory is wired yet", () => {
    expect(vaultFactoryOf("mainnet")).toBeNull();
    expect(vaultFactoryOf("testnet")).toBeNull();
  });

  it("reads the address the way the registry decides Vault is live, so the two never disagree", () => {
    for (const contracts of [null, undefined, {}, { vaultFactory: null }, { vaultFactory: "0x1234" }, { vaultFactory: 7 }, { vaultFactory: `0x${"0".repeat(40)}` }, { vaultFactory: ADDRESS }]) {
      expect(vaultFactoryOf("testnet", contracts), JSON.stringify(contracts)).toBe(contractAddress(contracts, "vaultFactory"));
    }
    expect(vaultFactoryOf("testnet", { ...ARCOS.testnet, vaultFactory: ADDRESS })).toBe(ADDRESS);
  });
});
