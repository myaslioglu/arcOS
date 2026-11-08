import { describe, expect, it } from "vitest";
import { getAddress, toEventSignature } from "viem";
import { ARCOS, PREVIOUS_MULTISENDS, STATS_FROM, USAGE_EVENTS, feeControllerAbi, multisendAbi, tokenFactoryAbi } from "../index";

const signatureOf = (abi: readonly { type: string; name?: string }[], name: string): string => {
  const item = abi.find((i) => i.type === "event" && i.name === name);
  if (!item) throw new Error(`no event ${name}`);
  return toEventSignature(item as never);
};

describe("PREVIOUS_MULTISENDS", () => {
  it("names mainnet's first Multisend, checksummed, and none on testnet", () => {
    expect(PREVIOUS_MULTISENDS).toEqual({ mainnet: ["0x03ddE90Fde3983CEEE600dbc9b76f6D73512af47"], testnet: [] });
    for (const a of PREVIOUS_MULTISENDS.mainnet) expect(getAddress(a)).toBe(a);
  });

  it("does not repeat the current Multisend", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      for (const a of PREVIOUS_MULTISENDS[network]) expect(a.toLowerCase()).not.toBe(ARCOS[network]?.multisend.toLowerCase());
    }
  });
});

describe("STATS_FROM", () => {
  it("starts mainnet's count at the FeeController's deployment block, dated, and keeps no count on testnet", () => {
    expect(STATS_FROM.mainnet).toEqual({ block: 22_742_796, at: "2026-09-25" });
    expect(STATS_FROM.mainnet?.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(STATS_FROM.testnet).toBeNull();
  });
});

describe("USAGE_EVENTS", () => {
  it("are the signatures of the events in the ABIs Stats reads", () => {
    expect(USAGE_EVENTS.tokenCreated).toBe(signatureOf(tokenFactoryAbi, "TokenCreated"));
    expect(USAGE_EVENTS.drop).toBe(signatureOf(multisendAbi, "Drop"));
    // The fee events the counter rebuilds the fees from are in the FeeController's ABI.
    expect(signatureOf(feeControllerAbi, "KeyAdded")).toBe("KeyAdded(bytes32,uint256,uint256)");
    expect(signatureOf(feeControllerAbi, "FeeChanged")).toBe("FeeChanged(bytes32,uint256)");
  });
});
