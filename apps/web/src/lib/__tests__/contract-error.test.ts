import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { feeControllerAbi, multisendAbi, tokenFactoryAbi } from "@arcos/chain";
import { describeContractError, GENERIC_TRANSACTION_ERROR, UserFacingError } from "../contract-error";

type AbiErrorItem = { type: string; name?: string };

/** Builds a fake error shaped like what viem hands the caller after decoding a revert: a
 * `ContractFunctionRevertedError` (by `.name`) carrying `.data.errorName`/`.data.args` — matching
 * viem's own `ContractFunctionRevertedError.data` shape (see node_modules/viem/errors/contract.ts). */
function revertError(errorName: string, args: readonly unknown[] = []): unknown {
  return { name: "ContractFunctionRevertedError", data: { errorName, args } };
}

const errorNamesOf = (abi: readonly AbiErrorItem[]): string[] =>
  abi.filter((item) => item.type === "error").map((item) => item.name!);

describe("describeContractError — ABI completeness", () => {
  const allErrorNames = new Set([
    ...errorNamesOf(feeControllerAbi),
    ...errorNamesOf(tokenFactoryAbi),
    ...errorNamesOf(multisendAbi),
  ]);

  it("covers every custom error declared across the three generated ABIs", () => {
    // A sanity check on the check itself: fails loudly if the ABIs ever stopped exporting errors,
    // rather than silently passing an empty loop below.
    expect(allErrorNames.size).toBeGreaterThan(10);
  });

  it("has a mapping for every custom error — fails if an ABI error has no mapping", () => {
    // Two dummy bigint args, not an empty array: a few mappings (AboveCap, WrongFee, WrongValue) read
    // a[0]/a[1] as bigints and now THROW — falling through to the generic message — when an expected
    // arg is missing/not a bigint (the asBigInt fix below). This test only checks "does a mapping
    // exist", so it needs args that won't trip that guard, not a realistic decode.
    for (const name of allErrorNames) {
      const message = describeContractError(revertError(name, [0n, 0n]));
      expect(message, `${name} must have a specific mapping, not the generic fallback`).not.toBe(GENERIC_TRANSACTION_ERROR);
    }
  });
});

describe("describeContractError", () => {
  it("maps TokenFactory's WrongFee(expected, sent) to Mint's fresh-fee wording", () => {
    const err = revertError("WrongFee", [15n * 10n ** 18n, 10n * 10n ** 18n]);
    expect(describeContractError(err)).toBe("The fee changed while you were signing. It is now 15 USDC — check it and submit again.");
  });

  it("maps Multisend's WrongValue(expected, sent) the same way, for the batch's total", () => {
    const err = revertError("WrongValue", [12345n * 10n ** 18n, 1n]);
    expect(describeContractError(err)).toBe("The amount sent doesn't match what's required. It should be 12345 USDC — check it and submit again.");
  });

  it("maps ZeroAmount(index) without claiming a CSV line number — index is a position WITHIN a batch, not a line in the list the user typed", () => {
    // Wording fix from the wave E review: "Row N" implied a CSV line number, but the contract's
    // `index` is local to the batch that was sent, which can — and for batch 2+ of a multi-batch send,
    // always does — diverge from the row's actual line in the original list.
    expect(describeContractError(revertError("ZeroAmount", [0n]))).toBe("An amount in this batch is zero.");
    expect(describeContractError(revertError("ZeroAmount", [3n]))).toBe("An amount in this batch is zero.");
  });

  it("maps BadName/BadSymbol to the actual on-chain rule, not a made-up one", () => {
    expect(describeContractError(revertError("BadName"))).toMatch(/64 bytes/);
    expect(describeContractError(revertError("BadName"))).toMatch(/space/);
    expect(describeContractError(revertError("BadName"))).toMatch(/control, invisible or text-direction characters/);
    expect(describeContractError(revertError("BadSymbol"))).toMatch(/16/);
    expect(describeContractError(revertError("BadSymbol"))).toMatch(/ASCII/);
  });

  it("maps Multisend's BadLists — the brief's 'TooManyRecipients' name doesn't exist in the ABI; BadLists is what the contract actually reverts with, and covers the 400 cap", () => {
    expect(describeContractError(revertError("BadLists"))).toMatch(/400/);
  });

  it("finds the revert nested arbitrarily deep in an error's cause chain", () => {
    const inner = revertError("ZeroAmount", [0n]);
    const middle = new Error("mid", { cause: inner });
    const outer = new Error("outer", { cause: middle });
    expect(describeContractError(outer)).toBe("An amount in this batch is zero.");
  });

  it("treats a user rejection as a cancellation, by name, before trying to decode a revert", () => {
    const err = Object.assign(new Error("denied"), { name: "UserRejectedRequestError" });
    expect(describeContractError(err)).toBe("You cancelled the request in your wallet.");
  });

  it("recognizes EIP-1193 error code 4001 as a user rejection", () => {
    expect(describeContractError({ code: 4001 })).toBe("You cancelled the request in your wallet.");
  });

  it("never leaks raw RPC text or a URL for an undecodable error", () => {
    const raw = new Error('execution reverted: see https://rpc.example/tx/0xabc for details, code=-32603');
    const message = describeContractError(raw);
    expect(message).toBe(GENERIC_TRANSACTION_ERROR);
    expect(message).not.toMatch(/https?:\/\//);
  });

  it("falls back safely for a non-object thrown value", () => {
    expect(describeContractError("nope")).toBe(GENERIC_TRANSACTION_ERROR);
    expect(describeContractError(null)).toBe(GENERIC_TRANSACTION_ERROR);
    expect(describeContractError(undefined)).toBe(GENERIC_TRANSACTION_ERROR);
  });

  it("falls back safely when the decoded error name isn't one of ours", () => {
    expect(describeContractError(revertError("SomeFutureError"))).toBe(GENERIC_TRANSACTION_ERROR);
  });

  it("returns a UserFacingError's own message verbatim — a message this app already wrote is not the generic-fallback situation", () => {
    const err = new UserFacingError("The fee changed to 5 USDC. Check it and submit again.");
    expect(describeContractError(err)).toBe("The fee changed to 5 USDC. Check it and submit again.");
  });

  it("checks UserFacingError before a user rejection or a decoded revert, since it's never ambiguous with either", () => {
    const err = new UserFacingError("Stop condition this app wrote itself.");
    expect(describeContractError(err)).toBe("Stop condition this app wrote itself.");
  });

  // asBigInt used to silently coerce a non-bigint arg to 0n, so a malformed/unexpected args shape
  // rendered a confident-looking but wrong "It is now 0 USDC" instead of the generic fallback.
  it("falls back to the generic message when a decoded revert's expected-bigint arg isn't actually a bigint", () => {
    const malformed = { name: "ContractFunctionRevertedError", data: { errorName: "WrongFee", args: ["not-a-bigint", 10n] } };
    const message = describeContractError(malformed);
    expect(message).toBe(GENERIC_TRANSACTION_ERROR);
    expect(message).not.toMatch(/0 USDC/);
  });

  it("still formats normally when the args ARE bigints", () => {
    expect(describeContractError(revertError("WrongFee", [15n * 10n ** 18n, 10n * 10n ** 18n]))).toBe(
      "The fee changed while you were signing. It is now 15 USDC — check it and submit again.",
    );
  });
});

/**
 * A source-text scan (this workspace has no jsdom harness — see AGENTS.md), not a runtime test: it
 * fails if any file under apps/web/src constructs a `UserFacingError` from external text (an error's
 * own `.message`, or a `String(err...)` coercion of one) rather than an app-authored literal sentence.
 * That's the one invariant `describeContractError` depends on to safely show a `UserFacingError`'s
 * message verbatim (see the class's own doc comment) — a single violation anywhere would let raw
 * wallet/RPC/transport text reach the user unfiltered.
 */
describe("UserFacingError is only ever constructed from an app-authored literal — never external text", () => {
  // This file's own source is exempt: it contains the literal text `new UserFacingError(` as scanner
  // configuration (the `marker` constant below), not a real call, and test fixtures elsewhere in this
  // suite legitimately construct `UserFacingError` instances from literal strings for other tests.
  const SELF = path.resolve(import.meta.dirname, "contract-error.test.ts");

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

  /** Extracts exactly the argument list of a call whose `(` is at `openParenIdx` — balancing nested
   * parens and skipping over string/template literal contents (so a paren inside a message string
   * can't desynchronize the count) — rather than a fixed-length lookahead, which would leak into
   * whatever code happens to follow a short call and produce false positives. */
  function extractBalancedArgs(source: string, openParenIdx: number): string {
    let depth = 1;
    let i = openParenIdx + 1;
    let inString: string | null = null;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === inString) inString = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
      i++;
    }
    return source.slice(openParenIdx + 1, i - 1);
  }

  /** Strips block and line comments before scanning, so a doc comment that merely MENTIONS
   * `new UserFacingError(...)` as documentation (e.g. this very rule's own explanation, a few lines
   * above in this file, and in contract-error.ts's class doc comment) is never counted as a real
   * call site or checked for an offense that only makes sense against real code. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  // wave G, N7: names an error-like variable a template literal might interpolate — e.g.
  // `` `Failed: ${err}` `` or `` `${error.shortMessage}` `` — which leaks whatever that value's own
  // message/toString happens to produce, exactly the hazard `.message`/`String(err` already guard
  // against, just spelled differently.
  const ERROR_LIKE_NAMES = ["e", "err", "error", "cause"];

  /** Every reason `args` (one call's extracted argument list) fails to look like an app-authored
   * literal — empty when it's fine. More than one reason can apply at once; all are reported. */
  function offenseReasons(args: string): string[] {
    const reasons: string[] = [];
    if (args.includes(".message")) reasons.push("reads .message");
    if (args.includes("String(err")) reasons.push("coerces String(err...)");
    // A bare identifier argument — e.g. `new UserFacingError(err)` — passes an external value
    // straight through with no literal wrapper at all, the most direct version of this hazard.
    if (/^[A-Za-z_$][\w$]*$/.test(args.trim())) reasons.push("is a bare identifier, not an app-authored literal");
    for (const name of ERROR_LIKE_NAMES) {
      if (new RegExp(`\\$\\{\\s*${name}\\b`).test(args)) reasons.push(`interpolates \${${name}...} in a template literal`);
    }
    return reasons;
  }

  it("finds no `new UserFacingError(...)` call built from external text — `.message`, `String(err`, a bare identifier, or a template interpolating an error-like variable", () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const offenders: string[] = [];
    let totalSites = 0;
    for (const file of listSourceFiles(root)) {
      const source = stripComments(readFileSync(file, "utf8"));
      const marker = "new UserFacingError(";
      let idx = source.indexOf(marker);
      while (idx !== -1) {
        totalSites++;
        const openParenIdx = idx + marker.length - 1;
        const args = extractBalancedArgs(source, openParenIdx);
        const reasons = offenseReasons(args);
        if (reasons.length > 0) {
          offenders.push(`${path.relative(root, file)}: new UserFacingError(${args}) — ${reasons.join(", ")}`);
        }
        idx = source.indexOf(marker, idx + marker.length);
      }
    }
    expect(offenders, `found UserFacingError built from external text:\n${offenders.join("\n")}`).toEqual([]);
    // A vacuous scan (zero construction sites found anywhere — production code or this suite's own
    // fixtures) would make the loop above pass trivially, which must fail loudly instead: it would
    // mean the pattern this test guards moved, was renamed, or was refactored out from under it.
    expect(totalSites).toBeGreaterThanOrEqual(4);
  });
});
