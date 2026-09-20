import { describe, expect, it } from "vitest";
import type { SwapResult } from "@circle-fin/app-kit";
import { presentSwapResult } from "../presentResult";

function result(over: Partial<SwapResult> & { progress: SwapResult["progress"] }): SwapResult {
  return { txHash: "0xabc", explorerUrl: "https://explorer.testnet.arc.io/tx/0xabc", ...over } as unknown as SwapResult;
}

describe("presentSwapResult", () => {
  it("DONE is the only success: ok tone, 'Swap complete', fires the success event", () => {
    const p = presentSwapResult(result({ progress: { status: "DONE" } }));
    expect(p).toMatchObject({ tone: "ok", headline: "Swap complete", reason: null, isSuccess: true });
    expect(p.explorerUrl).toBe("https://explorer.testnet.arc.io/tx/0xabc");
    expect(p.txHash).toBe("0xabc");
  });

  it("FAILED is a failure, not a success — warn tone, the SDK's own reason, no success event", () => {
    const p = presentSwapResult(result({ progress: { status: "FAILED", substatusMessage: "Route no longer available" } }));
    expect(p.tone).toBe("warn");
    expect(p.isSuccess).toBe(false);
    expect(p.reason).toBe("Route no longer available");
  });

  it("FAILED without a substatusMessage still gets a reason, never a blank one", () => {
    const p = presentSwapResult(result({ progress: { status: "FAILED" } }));
    expect(p.tone).toBe("warn");
    expect(p.reason).toBeTruthy();
  });

  it("NOT_FOUND is also a failure — warn tone, not a success", () => {
    const p = presentSwapResult(result({ progress: { status: "NOT_FOUND" } }));
    expect(p.tone).toBe("warn");
    expect(p.isSuccess).toBe(false);
    expect(p.reason).toBeTruthy();
  });

  it("a non-terminal or unknown status is shown neutrally, with the link, not as success or failure", () => {
    const p = presentSwapResult(result({ progress: { status: "PENDING" } }));
    expect(p).toMatchObject({ tone: "info", headline: "Swap submitted — check the transaction", reason: null, isSuccess: false });
    expect(p.explorerUrl).toBe("https://explorer.testnet.arc.io/tx/0xabc");
  });

  it("explorerUrl is null when the SDK didn't provide one", () => {
    const p = presentSwapResult(result({ progress: { status: "DONE" }, explorerUrl: undefined }));
    expect(p.explorerUrl).toBeNull();
  });
});
