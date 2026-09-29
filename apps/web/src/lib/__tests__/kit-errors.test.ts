import { describe, expect, it } from "vitest";
import { InputError, KitError, RateLimitError, RpcError } from "@circle-fin/app-kit";
import { classifyBridgeFailure } from "@/apps/bridge/session";
import { classifySwapFailure } from "@/apps/swap/session";
import { GENERIC_TRANSACTION_ERROR } from "../contract-error";
import { isKitCancellation } from "../kit-errors";
import { refusedSend, stubNoNetwork } from "./fixtures/kit-send";

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
    const permitDeclined = new KitError({ ...InputError.USER_CANCELLED, recoverability: "FATAL", message: "User cancelled permit signature request" });
    expect(isKitCancellation(permitDeclined)).toBe(true);
    const busy = new KitError({ ...RateLimitError.RATE_LIMIT_EXCEEDED, recoverability: "RETRYABLE", message: "Rate limit exceeded, please retry later" });
    expect(isKitCancellation(busy)).toBe(false);
    expect(isKitCancellation({ code: 4001, message: "User rejected the request." })).toBe(true);
    expect(isKitCancellation(new Error("User denied transaction signature"))).toBe(true);
    expect(isKitCancellation(new Error("boom"))).toBe(false);
    expect(isKitCancellation(null)).toBe(false);
  });

  it("looks through a nested RPC endpoint error, whose own 4001 says nothing either", () => {
    expect(isKitCancellation(rpcEndpointError(rpcEndpointError(new Error("boom"))))).toBe(false);
    expect(isKitCancellation(rpcEndpointError(rpcEndpointError(new Error("User rejected the request."))))).toBe(true);
  });

  it("answers no, never throws, for an error whose properties throw when read", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("no reading this"); } });
    expect(isKitCancellation(hostile)).toBe(false);
    expect(isKitCancellation(rpcEndpointError(hostile))).toBe(false);
  });

  it("answers no, never throws, for an error that loops (the kit's own check would throw on it)", () => {
    const looped: Record<string, unknown> = { message: "boom" };
    looped.self = looped;
    expect(isKitCancellation(looped)).toBe(false);
    expect(isKitCancellation(rpcEndpointError(looped))).toBe(false);
    const chain: { message: string; cause?: unknown } = { message: "boom" };
    chain.cause = chain;
    expect(isKitCancellation(rpcEndpointError(chain))).toBe(false);
  });
});

// Circle's real adapter (fixtures/kit-send.ts); it makes no network request.
describe("a failed send through Circle's own adapter", () => {
  stubNoNetwork();

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
    ["as a bare string", () => "User rejected the request."],
    ["with its words in a nested cause", () => new Error("Request failed", { cause: new Error("User rejected the request.") })],
    ["under code 4001", () => ({ code: 4001, message: "User rejected the request." })],
  ])("is a cancellation when the wallet refused %s", async (_shape, refuse) => {
    const err = await refusedSend(refuse);
    expect(isKitCancellation(err)).toBe(true);
    expect(classifySwapFailure(err)).toBe("Cancelled.");
    expect(classifyBridgeFailure(err, NOTE)).toBe("Cancelled.");
  });
});
