import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyBridgeFailure } from "@/apps/bridge/session";
import { classifySwapFailure } from "@/apps/swap/session";
import { EMBEDDED_FRAME_MESSAGE, isEmbeddedFrameRefusal } from "../wallet-frame";
import { refusedSend } from "./fixtures/kit-send";

const TEXT =
  "Request blocked: embedded frames are not allowed for this origin. For your security, 4rcos.com can't make this request from an embedded frame.";

// Circle's real adapter refuses the send (fixtures/kit-send.ts); it makes no network request.
beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("this test makes no network request")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a refusal at the send, through Circle's own adapter", () => {
  // With no code, the kit reports an RPC endpoint error whose own code is 4001, which its isUserCancellationError
  // reads as a cancellation. The wallet's words sit under cause.trace.rawError.
  it.each([
    ["an Error with no code", () => new Error(TEXT)],
    ["a bare string", () => TEXT],
  ])("is recognized from %s, and Swap and Bridge say to reload rather than 'Cancelled.'", async (_shape, refuse) => {
    const err = await refusedSend(refuse);
    expect(isEmbeddedFrameRefusal(err)).toBe(true);
    expect(classifySwapFailure(err)).toBe(EMBEDDED_FRAME_MESSAGE);
    expect(classifyBridgeFailure(err, "Check the explorer.")).toBe(EMBEDDED_FRAME_MESSAGE);
  });

  it.each([4100, 4001])("is recognized under code %i", async (code) => {
    expect(isEmbeddedFrameRefusal(await refusedSend(() => ({ code, message: TEXT })))).toBe(true);
  });

  it("leaves another failure alone", async () => {
    expect(isEmbeddedFrameRefusal(await refusedSend(() => new Error("boom")))).toBe(false);
  });

  it("still reads a real cancellation as cancelled", async () => {
    const err = await refusedSend(() => ({ code: 4001, message: "User rejected the request." }));
    expect(isEmbeddedFrameRefusal(err)).toBe(false);
    expect(classifySwapFailure(err)).toBe("Cancelled.");
  });
});
