import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KitError, RpcError } from "@circle-fin/app-kit";
import { classifyBridgeFailure } from "@/apps/bridge/session";
import { classifySwapFailure } from "@/apps/swap/session";
import { GENERIC_TRANSACTION_ERROR } from "../contract-error";
import { isKitCancellation } from "../kit-errors";
import { refusedSend } from "./fixtures/kit-send";

const SWAP_UNKNOWN = "The swap didn't finish. It may still have gone through, so check your wallet's activity before trying again.";
const NOTE = "Check the explorer.";

// The kit's RPC endpoint error, as its adapter builds it: code 4001, the wrapped error under cause.trace.rawError.
const rpcEndpointError = (rawError: unknown) =>
  new KitError({
    ...RpcError.ENDPOINT_ERROR,
    recoverability: "RETRYABLE",
    message: "RPC endpoint error on Arc Testnet",
    cause: { trace: { rawError } },
  });

describe("isKitCancellation", () => {
  it("doesn't read the kit's RPC endpoint error as a cancellation for its code 4001 alone", () => {
    expect(rpcEndpointError(new Error("boom")).code).toBe(4001);
    expect(isKitCancellation(rpcEndpointError(new Error("boom")))).toBe(false);
    expect(isKitCancellation(rpcEndpointError(undefined))).toBe(false);
  });

  it("reads it as a cancellation when the error it wraps is one", () => {
    expect(isKitCancellation(rpcEndpointError(new Error("User rejected the request.")))).toBe(true);
    expect(isKitCancellation(rpcEndpointError({ code: 4001, message: "User rejected the request." }))).toBe(true);
  });

  it("keeps the kit's own answer for everything else", () => {
    expect(isKitCancellation({ code: 4001, message: "User rejected the request." })).toBe(true);
    expect(isKitCancellation(new Error("User denied transaction signature"))).toBe(true);
    expect(isKitCancellation(new Error("boom"))).toBe(false);
    expect(isKitCancellation(null)).toBe(false);
  });
});

// Circle's real adapter (fixtures/kit-send.ts); it makes no network request.
describe("a failed send through Circle's own adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("this test makes no network request")));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["a node error", () => new Error("boom")],
    ["a failed fetch", () => new Error("fetch failed")],
  ])("is no cancellation after %s: Swap hedges and Bridge says it didn't go through", async (_cause, refuse) => {
    const err = await refusedSend(refuse);
    expect(isKitCancellation(err)).toBe(false);
    expect(classifySwapFailure(err)).toBe(SWAP_UNKNOWN);
    expect(classifyBridgeFailure(err, NOTE)).toBe(`${GENERIC_TRANSACTION_ERROR} ${NOTE}`);
  });

  it.each([
    ["with no code", () => new Error("User rejected the request.")],
    ["under code 4001", () => ({ code: 4001, message: "User rejected the request." })],
  ])("is a cancellation when the wallet refused %s", async (_shape, refuse) => {
    const err = await refusedSend(refuse);
    expect(isKitCancellation(err)).toBe(true);
    expect(classifySwapFailure(err)).toBe("Cancelled.");
    expect(classifyBridgeFailure(err, NOTE)).toBe("Cancelled.");
  });
});
