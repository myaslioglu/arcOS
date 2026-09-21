import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UserFacingError } from "../contract-error";
import { assertWalletOnChain, withChain } from "../paid-write";

describe("withChain", () => {
  it("returns the request with chainId set", () => {
    expect(withChain({ address: "0xabc" }, 5042)).toEqual({ address: "0xabc", chainId: 5042 });
  });

  it("preserves every other field on the request untouched", () => {
    const request = { functionName: "createToken", args: [1, 2, 3], value: 15n };
    expect(withChain(request, 5042)).toEqual({ ...request, chainId: 5042 });
  });

  it("overwrites a chainId already on the request rather than merging two", () => {
    expect(withChain({ chainId: 1 }, 5042)).toEqual({ chainId: 5042 });
  });

  // The whole point of this helper (see its doc comment): wagmi's writeContract silently sends on the
  // wallet's CURRENT chain — skipping viem's assertCurrentChain entirely — when chainId is undefined.
  // A caller that forgets to resolve a real chain id must fail loudly here, not send an unguarded
  // transaction.
  it("throws when chainId is undefined, instead of silently omitting it", () => {
    expect(() => withChain({ address: "0xabc" }, undefined)).toThrow(/chainId/i);
  });
});

describe("assertWalletOnChain", () => {
  it("does not throw when the wallet's chain matches the expected chain", () => {
    expect(() => assertWalletOnChain(5042, 5042)).not.toThrow();
  });

  it("throws a UserFacingError when the wallet is on a different chain", () => {
    expect(() => assertWalletOnChain(1, 5042)).toThrow(UserFacingError);
    expect(() => assertWalletOnChain(1, 5042)).toThrow("Your wallet is on a different network. Switch to Arc and try again.");
  });

  it("throws when the wallet's chain id is unknown (not connected / still resolving)", () => {
    expect(() => assertWalletOnChain(undefined, 5042)).toThrow(UserFacingError);
  });
});

/**
 * A plain source-text scan, not a component/integration test — this workspace has no jsdom harness
 * (see AGENTS.md / the wave E brief), so there is no way to render Window.tsx and click Submit. This
 * is the next best guard against the exact regression wave C introduced: it fails loudly the moment
 * any future edit adds a `writeContractAsync(` call to one of these files without routing it through
 * `withChain`, instead of silently shipping an unguarded write.
 */
const PAID_WRITE_FILES = ["../../apps/mint/Window.tsx", "../../apps/drop/useDrop.ts"];

function writeContractAsyncCallsAndArgs(source: string): string[] {
  const marker = "writeContractAsync(";
  // 60 chars of lookahead — comfortably more than prettier's deepest realistic indent before an
  // argument — trimmed below to just the first token, so this isn't sensitive to exact formatting.
  const lookahead = 60;
  const calls: string[] = [];
  let idx = source.indexOf(marker);
  while (idx !== -1) {
    calls.push(source.slice(idx + marker.length, idx + marker.length + lookahead));
    idx = source.indexOf(marker, idx + marker.length);
  }
  return calls;
}

describe("every paid writeContractAsync( call goes through withChain", () => {
  it.each(PAID_WRITE_FILES)("%s", (relPath) => {
    const source = readFileSync(path.resolve(import.meta.dirname, relPath), "utf8");
    const calls = writeContractAsyncCallsAndArgs(source);
    // A file with zero matches would make the loop below vacuously pass — that must fail loudly too,
    // since it means the paid write this test is meant to guard moved or was renamed out from under it.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // Trimmed, not a strict startsWith: the call may be formatted across lines (prettier can wrap a
      // long argument list), so only the first non-whitespace token after `writeContractAsync(` matters.
      expect(call.trimStart().startsWith("withChain("), `expected "writeContractAsync(${call}…" to start with "withChain("`).toBe(true);
    }
  });
});
