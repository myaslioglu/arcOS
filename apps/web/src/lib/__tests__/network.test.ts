import { describe, expect, it } from "vitest";
import { BaseError, SwitchChainError, UserRejectedRequestError } from "viem";
import { switchNetworkErrorMessage } from "../network";

const CHAIN_NAME = "Arc";
const REJECTED = "Your wallet didn't switch networks. Try again, or add Arc in your wallet.";

describe("switchNetworkErrorMessage", () => {
  it("reads as a rejection for a viem UserRejectedRequestError", () => {
    const err = new UserRejectedRequestError(new Error("user rejected"));
    expect(switchNetworkErrorMessage(err, CHAIN_NAME)).toBe(REJECTED);
  });

  it("reads as a rejection for a raw provider error carrying code 4001, unwrapped by viem", () => {
    const raw = { code: 4001, message: "User rejected" };
    expect(switchNetworkErrorMessage(raw, CHAIN_NAME)).toBe(REJECTED);
  });

  it("reads as a rejection when the rejection is nested in a cause chain", () => {
    const err = new SwitchChainError(new UserRejectedRequestError(new Error("user rejected")));
    expect(switchNetworkErrorMessage(err, CHAIN_NAME)).toBe(REJECTED);
  });

  it("reads as a rejection when a plain Error wraps a code-4001 cause", () => {
    const err = new Error("failed", { cause: { code: 4001 } });
    expect(switchNetworkErrorMessage(err, CHAIN_NAME)).toBe(REJECTED);
  });

  it("shows a viem error's short message for anything else", () => {
    const err = new SwitchChainError(new Error("network hiccup"));
    expect(switchNetworkErrorMessage(err, CHAIN_NAME)).toBe(err.shortMessage);
    expect(switchNetworkErrorMessage(err, CHAIN_NAME)).not.toBe(REJECTED);
  });

  it("shows a plain Error's message when it isn't a viem error", () => {
    expect(switchNetworkErrorMessage(new Error("boom"), CHAIN_NAME)).toBe("boom");
  });

  it("falls back to a generic message for a thrown non-Error value", () => {
    expect(switchNetworkErrorMessage("nope", CHAIN_NAME)).toBe("Something went wrong switching networks.");
    expect(switchNetworkErrorMessage(null, CHAIN_NAME)).toBe("Something went wrong switching networks.");
  });

  it("never mistakes an unrelated BaseError for a rejection", () => {
    const err = new BaseError("Something else broke.");
    expect(switchNetworkErrorMessage(err, CHAIN_NAME)).toBe("Something else broke.");
  });
});
