import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Abi } from "viem";
import { FEE_KEYS, lockVaultAbi, positionVaultAbi, vaultFactoryAbi } from "@arcos/chain";
import { GENERIC_TRANSACTION_ERROR, describeContractError } from "@/lib/contract-error";
import { POSITION_ISSUE } from "@/lib/positions";
import { LOCK_ABI, MANAGER_NOT_ALLOWED, NOT_CONNECTED, VAULT_ERRORS, WRONG_NETWORK, describeVaultError } from "../errors";

type AbiErrorItem = { type: string; name?: string; inputs?: readonly { type: string }[] };
const errorsOf = (abi: readonly AbiErrorItem[]) => abi.filter((i) => i.type === "error");
const ALL = [...errorsOf(vaultFactoryAbi), ...errorsOf(lockVaultAbi), ...errorsOf(positionVaultAbi)];

/** A revert as viem hands it over after decoding: the shape describeContractError walks for. */
const revert = (errorName: string, args: readonly unknown[] = []) => ({ name: "ContractFunctionRevertedError", data: { errorName, args } });

/** Dummy arguments of the right types, so a sentence that formats an argument has one. */
const argsFor = (item: AbiErrorItem) =>
  (item.inputs ?? []).map((i) => (i.type.startsWith("uint") ? 1_802_584_639n : i.type === "address" ? "0x1111111111111111111111111111111111111111" : `0x${"00".repeat(32)}`));

describe("describeVaultError: every error the VaultFactory and its vaults declare", () => {
  it("covers each one with a sentence of its own, never the generic fallback", () => {
    expect(ALL.length).toBeGreaterThan(25);
    for (const item of ALL) {
      expect(Object.hasOwn(VAULT_ERRORS, item.name!), item.name).toBe(true);
      const sentence = describeVaultError(revert(item.name!, argsFor(item)));
      expect(sentence, item.name).not.toBe(GENERIC_TRANSACTION_ERROR);
      expect(sentence, item.name).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("maps nothing the three ABIs don't declare", () => {
    const declared = new Set(ALL.map((i) => i.name));
    for (const name of Object.keys(VAULT_ERRORS)) expect(declared.has(name), name).toBe(true);
  });

  it("reads the vault's sentence before the shared one: ZeroAmount here is a lock that delivers nothing", () => {
    expect(describeVaultError(revert("ZeroAmount"))).toBe("Nothing would reach the vault: the amount is zero, or the token sent nothing.");
    expect(describeContractError(revert("ZeroAmount"))).toBe("An amount in this batch is zero.");
  });

  it("says the position refusals in the words the form uses before signing", () => {
    expect(describeVaultError(revert("NoLiquidity"))).toBe(POSITION_ISSUE.noLiquidity);
    expect(describeVaultError(revert("OwedNotCollected"))).toBe(POSITION_ISSUE.owed);
    expect(describeVaultError(revert("HookedPool"))).toBe(POSITION_ISSUE.hooked);
    // The shared map's HookedPool sentence is the same one.
    expect(describeContractError(revert("HookedPool"))).toBe(POSITION_ISSUE.hooked);
    expect(describeVaultError(revert("ManagerNotAllowed"))).toBe(MANAGER_NOT_ALLOWED);
  });

  it("names the new fee in WrongFee and the unlock date in StillLocked", () => {
    expect(describeVaultError(revert("WrongFee", [30n * 10n ** 18n, 1n]))).toBe(
      "The lock fee changed while you were signing. It is now 30 USDC. Check it and lock again.",
    );
    expect(describeVaultError(revert("StillLocked", [1_802_584_639n]))).toBe("This vault is locked until 14 Feb 2027, 05:57 UTC.");
  });

  it("says which share rose above the one this lock accepted (FeeAboveMax), to what, and that nothing was locked", () => {
    expect(describeVaultError(revert("FeeAboveMax", [FEE_KEYS.LOCK_LP_BPS, 100n, 50n]))).toBe(
      "ArcOS's share of an LP token lock rose to 1%, above the 0.5% this lock accepted. Nothing was locked and no fee was taken. Check it and lock again.",
    );
    expect(describeVaultError(revert("FeeAboveMax", [FEE_KEYS.LOCK_FEE_SHARE_BPS, 500n, 200n]))).toBe(
      "ArcOS's share of collected fees rose to 5%, above the 2% this lock accepted. Nothing was locked and no fee was taken. Check it and lock again.",
    );
    // A token the form didn't take for a pair (it accepted no share) that answered as one when the lock ran.
    expect(describeVaultError(revert("FeeAboveMax", [FEE_KEYS.LOCK_LP_BPS, 50n, 0n]))).toBe(
      "This token turned out to be a Uniswap v2 LP token, which pays ArcOS a share of 0.5% that this lock didn't accept. Nothing was locked and no fee was taken. Check it and lock again.",
    );
    // The key as viem may hand it over in capitals, and a key no lock pays.
    expect(describeVaultError(revert("FeeAboveMax", [FEE_KEYS.LOCK_LP_BPS.toUpperCase().replace("0X", "0x"), 100n, 50n]))).toMatch(/^ArcOS's share of an LP token lock rose to 1%/);
    expect(describeVaultError(revert("FeeAboveMax", [FEE_KEYS.LOCK_FLAT, 2n, 1n]))).toBe(
      "ArcOS's share rose above what this lock accepted. Nothing was locked and no fee was taken. Check it and lock again.",
    );
    expect(describeVaultError(revert("FeeAboveMax", [FEE_KEYS.LOCK_LP_BPS, "100", 50n]))).toBe(GENERIC_TRANSACTION_ERROR);
  });

  it("says a wallet on another network, or not connected, in so many words: nothing was sent", () => {
    expect(describeVaultError({ name: "TransactionExecutionError", cause: { name: "ChainMismatchError" } })).toBe(WRONG_NETWORK);
    expect(describeVaultError({ name: "ConnectorChainMismatchError" })).toBe(WRONG_NETWORK);
    for (const name of ["ConnectorNotConnectedError", "ConnectorAccountNotFoundError", "AccountNotFoundError"]) {
      expect(describeVaultError({ name: "WriteContractError", cause: { name } }), name).toBe(NOT_CONNECTED);
    }
  });

  it("falls back to the generic sentence for an argument of the wrong shape", () => {
    expect(describeVaultError(revert("WrongFee", ["30"]))).toBe(GENERIC_TRANSACTION_ERROR);
    expect(describeVaultError(revert("StillLocked", [null]))).toBe(GENERIC_TRANSACTION_ERROR);
  });

  it("still says a cancellation, a refusal for funds, and anything unknown the shared way", () => {
    expect(describeVaultError({ code: 4001 })).toBe("You cancelled the request in your wallet.");
    expect(describeVaultError(new Error("execution reverted: https://rpc.example"))).toBe(GENERIC_TRANSACTION_ERROR);
  });
});

describe("LOCK_ABI: the factory's ABI, able to name the vault's errors a lock call reverts with", () => {
  const lockAbi = LOCK_ABI as Abi;

  it("keeps every factory item and adds each vault error once", () => {
    for (const item of vaultFactoryAbi) expect(LOCK_ABI).toContain(item);
    const names = errorsOf(LOCK_ABI as readonly AbiErrorItem[]).map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ["BadUnlockTime", "ZeroAddress", "NotOwner", "UnexpectedNft", "StillLocked"]) expect(names, name).toContain(name);
  });

  it("decodes BadUnlockTime, raised by the new vault's initialize inside lockToken, where the factory's ABI alone can't", () => {
    const data = encodeErrorResult({ abi: lockVaultAbi, errorName: "BadUnlockTime" });
    const named = new ContractFunctionRevertedError({ abi: lockAbi, data, functionName: "lockToken" });
    expect(named.data?.errorName).toBe("BadUnlockTime");
    expect(describeVaultError(new BaseError("simulate failed", { cause: named }))).toBe(
      "The unlock date must be in the future, at most 10 years from now, and later than the current one.",
    );
    const unnamed = new ContractFunctionRevertedError({ abi: vaultFactoryAbi as Abi, data, functionName: "lockToken" });
    expect(unnamed.data).toBeUndefined();
    expect(describeVaultError(unnamed)).toBe(GENERIC_TRANSACTION_ERROR);
  });

  it("decodes the factory's own errors with their arguments", () => {
    const data = encodeErrorResult({ abi: vaultFactoryAbi, errorName: "WrongFee", args: [30n * 10n ** 18n, 0n] });
    const err = new ContractFunctionRevertedError({ abi: lockAbi, data, functionName: "lockToken" });
    expect(describeVaultError(err)).toBe("The lock fee changed while you were signing. It is now 30 USDC. Check it and lock again.");
    const above = encodeErrorResult({ abi: vaultFactoryAbi, errorName: "FeeAboveMax", args: [FEE_KEYS.LOCK_FEE_SHARE_BPS, 300n, 200n] });
    expect(describeVaultError(new ContractFunctionRevertedError({ abi: lockAbi, data: above, functionName: "lockPosition" }))).toMatch(
      /^ArcOS's share of collected fees rose to 3%, above the 2% this lock accepted\./,
    );
  });
});
