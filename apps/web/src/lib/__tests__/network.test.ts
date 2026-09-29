import { describe, expect, it } from "vitest";
import { BaseError, ResourceUnavailableRpcError, SwitchChainError, UserRejectedRequestError } from "viem";
import { WalletConnectLoadError } from "@/providers/lazyWalletConnect";
import { ALREADY_OPEN_MESSAGE, connectErrorMessage, switchNetworkErrorMessage } from "../network";

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

  it("maps a bare, unwrapped code 4902 (chain not added to the wallet) to a specific, actionable sentence", () => {
    // A wallet that hasn't been taught the chain can send this raw, before viem ever wraps it.
    const err = { code: 4902, message: "Unrecognized chain." };
    const message = switchNetworkErrorMessage(err, CHAIN_NAME);
    expect(message).toMatch(/isn't added/i);
    expect(message).toMatch(/Arc/);
    expect(message).not.toBe(REJECTED);
    expect(message).not.toMatch(/Unrecognized chain/);
  });

  // The defect this wave fixes: wagmi wraps EVERY non-rejection switchChain failure in viem's own
  // SwitchChainError, whose `.code` is 4902 BY CONSTRUCTION (see node_modules/viem/errors/rpc.ts —
  // RpcError's constructor hardcodes the class's static code unless the immediate cause is itself a
  // raw RpcRequestError). Reading that outer code, as errorCode used to, means almost any switch
  // failure — a request already open, a transport hiccup, anything — reads as "chain not added". The
  // fix skips a SwitchChainError node and reads the code from what's underneath it instead.

  it("does NOT read a SwitchChainError's own 4902 code — an unrecognized cause underneath gets the generic sentence", () => {
    const err = new SwitchChainError(new Error("x"));
    const message = switchNetworkErrorMessage(err, CHAIN_NAME);
    expect(message).toBe(GENERIC);
    expect(message).not.toMatch(/isn't added/i);
  });

  it("finds the real code underneath a SwitchChainError: a wrapped ResourceUnavailableRpcError (-32002) reads as already-open, not isn't-added", () => {
    const err = new SwitchChainError(new ResourceUnavailableRpcError(new Error("x")));
    const message = switchNetworkErrorMessage(err, CHAIN_NAME);
    expect(message).toBe(ALREADY_OPEN_MESSAGE);
    expect(message).not.toMatch(/isn't added/i);
  });

  it("maps code -32002 (a request is already pending in the wallet) to a specific sentence", () => {
    const err = { code: -32002, message: "Request of type 'wallet_switchEthereumChain' already pending" };
    const message = switchNetworkErrorMessage(err, CHAIN_NAME);
    expect(message).toBe(ALREADY_OPEN_MESSAGE);
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

// The other defect this wave fixes: the Wallet window rendered a connect error's raw `.message`
// straight from useConnect() — wallet/transport text that can carry internal detail or a URL. Never
// the wallet's own text; one plain sentence per condition instead, same rule as switchNetworkErrorMessage.
describe("connectErrorMessage", () => {
  it("reads as a rejection for a viem UserRejectedRequestError", () => {
    const err = new UserRejectedRequestError(new Error("user rejected"));
    expect(connectErrorMessage(err)).toBe("You cancelled the request in your wallet.");
  });

  it("reads as a rejection for a raw provider error carrying code 4001, unwrapped by viem", () => {
    expect(connectErrorMessage({ code: 4001, message: "User rejected" })).toBe("You cancelled the request in your wallet.");
  });

  it("maps code -32002 (a request is already pending in the wallet) to the same already-open sentence switching uses", () => {
    const err = new ResourceUnavailableRpcError(new Error("x"));
    expect(connectErrorMessage(err)).toBe(ALREADY_OPEN_MESSAGE);
  });

  it("never returns the error's own text — an unknown error's message is not shown, even in part", () => {
    const err = new Error("visit evil.example");
    const message = connectErrorMessage(err);
    expect(message).toBe("Your wallet couldn't connect. Try again.");
    expect(message).not.toMatch(/evil\.example/);
  });

  it("falls back to the generic connect sentence for a thrown non-Error value", () => {
    expect(connectErrorMessage("nope")).toBe("Your wallet couldn't connect. Try again.");
    expect(connectErrorMessage(null)).toBe("Your wallet couldn't connect. Try again.");
  });
});

// Phones connect through WalletConnect, whose modal can be closed before any wallet answers. wagmi's walletConnect connector
// turns the provider's "Connection request reset" error, and a wallet's own "User rejected", into viem's
// UserRejectedRequestError, so both read like any other refused connection (lazyWalletConnect.test.ts checks that through
// wagmi's real connect flow; these pin what the message does with the shapes that come out).
describe("connectErrorMessage for a WalletConnect connection", () => {
  const CANCELLED = "You cancelled the request in your wallet.";
  const GENERIC = "Your wallet couldn't connect. Try again.";

  it("reads a closed WalletConnect modal as a cancelled request", () => {
    const err = new UserRejectedRequestError(new Error("Connection request reset. Please try again."));
    expect(connectErrorMessage(err)).toBe(CANCELLED);
  });

  it("reads a phone wallet's refusal the same way", () => {
    expect(connectErrorMessage(new UserRejectedRequestError(new Error("User rejected.")))).toBe(CANCELLED);
  });

  it("gives the generic sentence for a WalletConnect failure that isn't a refusal, never the provider's own words", () => {
    for (const text of [
      "Proposal expired",
      "To use QR modal, please install @reown/appkit package",
      "WebSocket connection failed for host: wss://relay.walletconnect.org",
    ]) {
      const message = connectErrorMessage(new Error(text));
      expect(message).toBe(GENERIC);
      expect(message).not.toContain("relay");
    }
  });
});

// wagmi's WalletConnect connector keeps a provider load that failed, so the button fails again until the page reloads.
// lazyWalletConnect raises a WalletConnectLoadError for that, and only for that: a wallet's own refusal isn't cured by a reload.
describe("connectErrorMessage when WalletConnect can't load", () => {
  const RELOAD = "WalletConnect couldn't load. Reload the page and try again.";
  const failedLoad = new Error("Failed to fetch dynamically imported module: https://4rcos.com/_next/static/chunks/0a1b.js");

  it("says to reload the page, and never shows the failure's own words", () => {
    const message = connectErrorMessage(new WalletConnectLoadError(failedLoad));
    expect(message).toBe(RELOAD);
    expect(message).not.toMatch(/chunks|dynamically|fetch/i);
  });

  it("finds it wrapped in another error's cause chain", () => {
    expect(connectErrorMessage(new Error("connect failed", { cause: new WalletConnectLoadError(failedLoad) }))).toBe(RELOAD);
  });

  it("does not read the load failure itself as one", () => {
    expect(connectErrorMessage(failedLoad)).toBe("Your wallet couldn't connect. Try again.");
  });

  it("still reads a refusal first", () => {
    const refusal = new UserRejectedRequestError(new Error("User rejected."));
    expect(connectErrorMessage(refusal)).toBe("You cancelled the request in your wallet.");
  });
});
