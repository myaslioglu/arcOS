import { readFileSync, readdirSync } from "node:fs";
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
 * any future edit adds an unguarded paid write, instead of silently shipping it.
 *
 * Wave G, N3: the original version of this scan hard-coded two file paths. That missed any THIRD
 * file that might one day make a paid write, and — worse — it trusted the literal identifier
 * `writeContractAsync` to still be in scope, which a destructuring rename
 * (`const { writeContractAsync: doIt } = useWriteContract()`) would silently defeat: every call
 * after that rename would read `doIt(...)`, invisible to a scan for the literal text
 * `writeContractAsync(`. This version instead walks the whole `apps/web/src` tree (reusing the
 * directory walk in contract-error.test.ts), scans every file that MENTIONS one of the three wagmi/
 * viem paid-write functions (`writeContractAsync`, `writeContract(`, `sendTransaction`) — not just
 * the two files it used to hard-code — and separately fails outright if it finds that exact
 * aliasing pattern anywhere, so a future rename can't quietly walk the guard right off a cliff.
 */
describe("every paid write goes through withChain (writeContractAsync / writeContract / sendTransaction)", () => {
  const root = path.resolve(import.meta.dirname, "..", "..");
  // This file's own source is exempt: it contains the literal marker text below as scanner
  // configuration, and the doc comment above mentions the very identifiers being scanned for.
  const SELF = path.resolve(import.meta.dirname, "paid-write.test.ts");

  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listSourceFiles(full));
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && full !== SELF) out.push(full);
    }
    return out;
  }

  /** Strips both block comments and line comments so a doc comment that merely MENTIONS one of
   * these function names (e.g. this module's own `paid-write.ts`, which explains
   * `writeContractAsync`'s behaviour but never calls it) can't be misread as a real, unwrapped call
   * site. Good enough for this codebase's actual files — none of the real call sites below share a
   * line with a comment or a string containing two consecutive slashes — without needing a full
   * tokenizer. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const FUNCTION_NAMES = ["writeContractAsync", "writeContract", "sendTransaction"];
  // File-selection net: any file mentioning any of these three names at all (call, comment, or
  // otherwise) is worth scanning — a file with a comment-only mention (e.g. mint/session.ts) simply
  // contributes zero call sites below, rather than being silently skipped.
  const FILE_MENTION_MARKERS = ["writeContractAsync", "writeContract(", "sendTransaction"];
  const matchedFiles = listSourceFiles(root).filter((f) => {
    const source = readFileSync(f, "utf8");
    return FILE_MENTION_MARKERS.some((m) => source.includes(m));
  });

  const CALL_MARKERS = FUNCTION_NAMES.map((name) => `${name}(`);
  const LOOKAHEAD = 60; // comfortably more than prettier's deepest realistic indent before an argument

  /** Every `name(` call site in `source`, with `LOOKAHEAD` characters of trailing text — trimmed
   * below to just the first token, so this isn't sensitive to exact formatting. */
  function callSitesAndArgs(source: string): string[] {
    const calls: string[] = [];
    for (const marker of CALL_MARKERS) {
      let idx = source.indexOf(marker);
      while (idx !== -1) {
        calls.push(source.slice(idx + marker.length, idx + marker.length + LOOKAHEAD));
        idx = source.indexOf(marker, idx + marker.length);
      }
    }
    return calls;
  }

  it("scans at least the two known paid-write files — a future move/rename must not silently drop them from the file set", () => {
    expect(matchedFiles.some((f) => f.endsWith(path.join("apps", "mint", "Window.tsx")))).toBe(true);
    expect(matchedFiles.some((f) => f.endsWith(path.join("apps", "drop", "useDrop.ts")))).toBe(true);
  });

  it("finds no destructuring alias of writeContractAsync/writeContract/sendTransaction — that would let a call bypass this whole scan", () => {
    const offenders: string[] = [];
    for (const file of matchedFiles) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      for (const name of FUNCTION_NAMES) {
        const re = new RegExp(`\\b${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped))) {
          if (m[1] !== name) offenders.push(`${path.relative(root, file)}: \`${name}: ${m[1]}\``);
        }
      }
    }
    expect(offenders, `found a destructuring rename that would hide a paid write from this scan:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("every call site, across every file that mentions one of these functions, is wrapped in withChain(...)", () => {
    let totalCalls = 0;
    const offenders: string[] = [];
    for (const file of matchedFiles) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      const calls = callSitesAndArgs(stripped);
      totalCalls += calls.length;
      for (const call of calls) {
        // Trimmed, not a strict startsWith: the call may be formatted across lines (prettier can
        // wrap a long argument list), so only the first non-whitespace token after the marker matters.
        if (!call.trimStart().startsWith("withChain(")) {
          offenders.push(`${path.relative(root, file)}: ...(${call}…`);
        }
      }
    }
    expect(offenders, `found a paid write not wrapped in withChain:\n${offenders.join("\n")}`).toEqual([]);
    // A vacuous scan (zero calls found anywhere) would make the loop above pass trivially — fail
    // loudly instead, since it means every paid write this test is meant to guard moved, was
    // renamed, or was refactored out from under it.
    expect(totalCalls).toBeGreaterThanOrEqual(4);
  });
});
