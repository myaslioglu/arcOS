import { describe, expect, it, vi } from "vitest";

const { FACTORY, VAULT } = vi.hoisted(() => ({ FACTORY: "0x5555555555555555555555555555555555555555", VAULT: "0x6666666666666666666666666666666666666666" }));

vi.mock("@arcos/chain", async (original) => {
  const real = await original<typeof import("@arcos/chain")>();
  return { ...real, ARCOS: { ...real.ARCOS, testnet: { ...real.ARCOS.testnet!, vestingFactory: FACTORY, vaultFactory: VAULT }, mainnet: { ...real.ARCOS.mainnet! } } };
});

import { spenderLabel } from "../approvals";

describe("Revoke names the VestingFactory", () => {
  it("labels the network's vestingFactory, in any case, and only on that network", () => {
    expect(spenderLabel(FACTORY, "testnet")).toBe("ArcOS Vesting");
    expect(spenderLabel(FACTORY.toUpperCase().replace("0X", "0x"), "testnet")).toBe("ArcOS Vesting");
    expect(spenderLabel(FACTORY, "mainnet")).toBeNull();
  });
  it("leaves the vaultFactory to the Vault app", () => {
    expect(spenderLabel(VAULT, "testnet")).toBeNull();
  });
});
