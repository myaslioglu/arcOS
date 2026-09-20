import { describe, expect, it } from "vitest";
import type { BridgeStep } from "@circle-fin/app-kit";
import { explorerCheckNote, fundsLeftSource, inFlightNote } from "../inFlight";

const step = (over: Partial<BridgeStep>): BridgeStep => ({ name: "Approve", state: "success", ...over });

describe("fundsLeftSource", () => {
  it("is false with no steps at all", () => {
    expect(fundsLeftSource([])).toBe(false);
  });

  it("is false when only approval succeeded — an allowance isn't money moving", () => {
    expect(fundsLeftSource([step({ name: "Approve", state: "success" })])).toBe(false);
  });

  it("is true once the burn step succeeded", () => {
    expect(fundsLeftSource([step({ name: "Burn", state: "success" })])).toBe(true);
  });

  it("matches case-insensitively — the SDK's own CCTPV2Actions keys are lowercase ('burn')", () => {
    expect(fundsLeftSource([step({ name: "burn", state: "success" })])).toBe(true);
  });

  it("is false when the burn step exists but hasn't succeeded yet", () => {
    expect(fundsLeftSource([step({ name: "Burn", state: "pending" })])).toBe(false);
    expect(fundsLeftSource([step({ name: "Burn", state: "error" })])).toBe(false);
  });

  it("is true if any step in the list succeeded, regardless of later failures", () => {
    expect(
      fundsLeftSource([step({ name: "Approve", state: "success" }), step({ name: "Burn", state: "success" }), step({ name: "Mint", state: "error" })]),
    ).toBe(true);
  });
});

describe("inFlightNote", () => {
  it("is null when funds never left — nothing to reassure the user about", () => {
    expect(inFlightNote("Ethereum Sepolia", "Arc Testnet", false)).toBeNull();
  });

  it("names the source and destination chains when funds left", () => {
    expect(inFlightNote("Ethereum Sepolia", "Arc Testnet", true)).toBe(
      "Your USDC left Ethereum Sepolia. It isn't lost: it can still be delivered on Arc Testnet.",
    );
  });
});

describe("explorerCheckNote", () => {
  it("names the source chain to check", () => {
    expect(explorerCheckNote("Ethereum Sepolia")).toBe(
      "If your wallet confirmed a transaction on Ethereum Sepolia, check it in that chain's explorer before trying again.",
    );
  });
});
