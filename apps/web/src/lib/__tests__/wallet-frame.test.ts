import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, SwitchChainError, UnauthorizedProviderError, UserRejectedRequestError, type Abi, type BaseError } from "viem";
import { EMBEDDED_FRAME_MESSAGE, isEmbeddedFrameRefusal } from "../wallet-frame";

// Trust Wallet's browser extension, word for word, for a page it takes for an embedded frame.
const TRUST_WALLET_TEXT =
  "Request blocked: embedded frames are not allowed for this origin. For your security, 4rcos.com can't make this request from an embedded frame.";

// A viem contract error composes its message from the call's arguments: here, a token name a visitor typed.
const CREATE_TOKEN_ABI = [
  { type: "function", name: "createToken", stateMutability: "payable", inputs: [{ name: "name", type: "string" }], outputs: [] },
] as const satisfies Abi;
const contractError = (cause: BaseError, name: string) =>
  new ContractFunctionExecutionError(cause, { abi: CREATE_TOKEN_ABI, functionName: "createToken", args: [name] });

describe("isEmbeddedFrameRefusal", () => {
  it("recognizes the wallet's raw error object", () => {
    expect(isEmbeddedFrameRefusal({ code: 4100, message: TRUST_WALLET_TEXT })).toBe(true);
  });

  it("recognizes it under a rejection code, which it must not be read as", () => {
    expect(isEmbeddedFrameRefusal({ code: 4001, message: TRUST_WALLET_TEXT })).toBe(true);
  });

  it("recognizes it wrapped by viem", () => {
    expect(isEmbeddedFrameRefusal(new UnauthorizedProviderError(new Error(TRUST_WALLET_TEXT)))).toBe(true);
    expect(isEmbeddedFrameRefusal(new UserRejectedRequestError(new Error(TRUST_WALLET_TEXT)))).toBe(true);
  });

  it("recognizes it deeper in a cause chain", () => {
    expect(isEmbeddedFrameRefusal(new Error("connect failed", { cause: { message: TRUST_WALLET_TEXT } }))).toBe(true);
  });

  it("recognizes a wallet that rejects with a bare string", () => {
    expect(isEmbeddedFrameRefusal(TRUST_WALLET_TEXT)).toBe(true);
  });

  it("never reads a viem error's composed message, where the visitor's own words can sit", () => {
    const err = contractError(new UserRejectedRequestError(new Error("User rejected the request.")), "Embedded Frame Coin");
    expect(err.message).toContain("Embedded Frame Coin");
    expect(isEmbeddedFrameRefusal(err)).toBe(false);
  });

  it("still finds the wallet's words under a viem contract error", () => {
    expect(isEmbeddedFrameRefusal(contractError(new UnauthorizedProviderError(new Error(TRUST_WALLET_TEXT)), "Plain Coin"))).toBe(true);
  });

  it("recognizes a bare string as a cause", () => {
    expect(isEmbeddedFrameRefusal(new SwitchChainError(TRUST_WALLET_TEXT as unknown as Error))).toBe(true);
    expect(isEmbeddedFrameRefusal({ message: "switch failed", cause: TRUST_WALLET_TEXT })).toBe(true);
  });

  it("follows Circle's App Kit, which keeps the error it wraps under cause.trace.originalError", () => {
    const kitError = new Error("Swap failed", { cause: { trace: { originalError: new Error(TRUST_WALLET_TEXT) } } });
    expect(isEmbeddedFrameRefusal(kitError)).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isEmbeddedFrameRefusal(new UserRejectedRequestError(new Error("User rejected the request.")))).toBe(false);
    expect(isEmbeddedFrameRefusal({ code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" })).toBe(false);
    expect(isEmbeddedFrameRefusal(new Error("frame not found"))).toBe(false);
    expect(isEmbeddedFrameRefusal("User rejected")).toBe(false);
    expect(isEmbeddedFrameRefusal(undefined)).toBe(false);
    expect(isEmbeddedFrameRefusal(null)).toBe(false);
  });

  it("stops on a cause chain that loops", () => {
    const a: { message: string; cause?: unknown } = { message: "a" };
    const b = { message: "b", cause: a };
    a.cause = b;
    expect(isEmbeddedFrameRefusal(a)).toBe(false);
  });

  it("tells the visitor what to do, in words of its own", () => {
    expect(EMBEDDED_FRAME_MESSAGE).toMatch(/Reload the page/);
    expect(EMBEDDED_FRAME_MESSAGE).not.toMatch(/Request blocked|For your security/);
  });
});
