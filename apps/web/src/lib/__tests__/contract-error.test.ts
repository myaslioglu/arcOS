import { describe, expect, it } from "vitest";
import { feeControllerAbi, multisendAbi, tokenFactoryAbi } from "@arcos/chain";
import { describeContractError, GENERIC_TRANSACTION_ERROR } from "../contract-error";

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
    expect(allErrorNames.size).toBeGreaterThan (10);
  });

  it("has a mapping for every custom error — fails if an ABI error has no mapping", () => {
    for (const name of allErrorNames) {
      const message = describeContractError(revertError(name, []));
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

  it("maps ZeroAmount(index) to a 1-based row number", () => {
    expect(describeContractError(revertError("ZeroAmount", [0n]))).toBe("Row 1 has a zero amount.");
    expect(describeContractError(revertError("ZeroAmount", [3n]))).toBe("Row 4 has a zero amount.");
  });

  it("maps BadName/BadSymbol to the actual on-chain rule, not a made-up one", () => {
    expect(describeContractError(revertError("BadName"))).toMatch(/64 bytes/);
    expect(describeContractError(revertError("BadName"))).toMatch(/space/);
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
    expect(describeContractError(outer)).toBe("Row 1 has a zero amount.");
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
});
