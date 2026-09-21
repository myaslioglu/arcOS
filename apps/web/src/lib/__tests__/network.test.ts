import { describe, expect, it } from "vitest";
import { BaseError, SwitchChainError, UserRejectedRequestError } from "viem";
import { switchNetworkErrorMessage } from "../network";

const CHAIN_NAME = "Arc";
const REJECTED = "Your wallet didn't switch networks. Try again, or add Arc in your wallet.";
const GENERIC = "Something went wrong switching networks.";

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

  // Wave E "should fix": network.ts was the last unguarded error surface — it returned a viem error's
  // shortMessage, or a plain Error's own .message, straight to the UI. Neither is guaranteed to be
  // free of raw RPC/provider/transport detail. Known EIP-1193 codes now map to a specific sentence;
  // everything else gets one generic sentence, never the error's own text.

  it("maps code 4902 (chain not added to the wallet) to a specific, actionable sentence", () => {
    // viem's own SwitchChainError carries code 4902 by construction — exactly what a wallet without
    // the chain added throws.
    const err = new SwitchChainError(new Error("Unrecognized chain."));
    const message = switchNetworkErrorMessage(err, CHAIN_NAME);
    expect(message).toMatch(/isn't added/i);
    expect(message).toMatch(/Arc/);
    expect(message).not.toBe(REJECTED);
    expect(message).not.toMatch(/Unrecognized chain/);
  });

  it("maps code -32002 (a request is already pending in the wallet) to a specific sentence", () => {
    const err = { code: -32002, message: "Request of type 'wallet_switchEthereumChain' already pending" };
    const message = switchNetworkErrorMessage(err, CHAIN_NAME);
    expect(message).toMatch(/already/i);
    expect(message).not.toMatch(/wallet_switchEthereumChain/);
  });

  it("finds a numeric code nested in a cause chain, same as the rejection check", () => {
    const err = new Error("failed", { cause: { code: 4902 } });
    expect(switchNetworkErrorMessage(err, CHAIN_NAME)).toMatch(/isn't added/i);
  });

  it("falls back to the generic sentence for an unrecognized code or error shape — never the error's own message", () => {
    const err = new BaseError("Something else broke, with internal RPC detail: https://rpc.internal/x");
    const message = switchNetworkErrorMessage(err, CHAIN_NAME);
    expect(message).toBe(GENERIC);
    expect(message).not.toMatch(/rpc\.internal/);
  });

  it("falls back to the generic sentence for a plain Error with no recognized code", () => {
    expect(switchNetworkErrorMessage(new Error("boom, some raw detail"), CHAIN_NAME)).toBe(GENERIC);
  });

  it("falls back to the generic sentence for a thrown non-Error value", () => {
    expect(switchNetworkErrorMessage("nope", CHAIN_NAME)).toBe(GENERIC);
    expect(switchNetworkErrorMessage(null, CHAIN_NAME)).toBe(GENERIC);
  });
});
