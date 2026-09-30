import { describe, expect, it } from "vitest";
import { keccak256, toBytes, toHex } from "viem";
import { FEE_KEYS, feeControllerAbi, lockVaultAbi, multisendAbi, tokenFactoryAbi, vaultFactoryAbi } from "../abis";
import { arcVestingAbi, proPassAbi, vestingFactoryAbi } from "../abis";

type AbiInput = { name?: string };
type AbiItem = { type: string; name?: string; inputs?: readonly AbiInput[] };

const names = (abi: readonly AbiItem[], type: string) =>
  abi.filter((item) => item.type === type).map((item) => item.name);

const hasType = (abi: readonly AbiItem[], type: string) => abi.some((item) => item.type === type);

const findItem = (abi: readonly AbiItem[], type: string, name: string) =>
  abi.find((item) => item.type === type && item.name === name);

const inputNames = (item: AbiItem | undefined) => (item?.inputs ?? []).map((input) => input.name);

describe("abis", () => {
  it("feeControllerAbi exposes the functions the app calls", () => {
    const fns = names(feeControllerAbi, "function");
    expect(fns).toContain("feeOf");
    expect(fns).toContain("recipient");
  });

  it("feeControllerAbi's renounceOwnership is permanently disabled", () => {
    expect(names(feeControllerAbi, "error")).toContain("RenounceDisabled");
  });

  it("tokenFactoryAbi exposes the functions and events the app calls", () => {
    const fns = names(tokenFactoryAbi, "function");
    expect(fns).toContain("createToken");
    expect(fns).toContain("tokensOf");
    expect(names(tokenFactoryAbi, "event")).toContain("TokenCreated");
  });

  it("tokenFactoryAbi exposes the forever-usable registry paging functions", () => {
    const fns = names(tokenFactoryAbi, "function");
    expect(fns).toContain("tokenCountOf");
    expect(fns).toContain("tokensOfSlice");
  });

  it("tokenFactoryAbi's TokenCreated event carries a holder input", () => {
    const event = findItem(tokenFactoryAbi, "event", "TokenCreated");
    expect(inputNames(event)).toContain("holder");
  });

  it("multisendAbi exposes the functions and events the app calls", () => {
    const fns = names(multisendAbi, "function");
    expect(fns).toContain("quote");
    expect(fns).toContain("sendNative");
    expect(fns).toContain("sendToken");
    const events = names(multisendAbi, "event");
    expect(events).toContain("Drop");
    expect(events).toContain("TransferFailed");
  });

  it("multisendAbi's TransferFailed event carries an index input", () => {
    const event = findItem(multisendAbi, "event", "TransferFailed");
    expect(inputNames(event)).toContain("index");
  });

  it("multisendAbi's Drop event carries a failedCount input", () => {
    const event = findItem(multisendAbi, "event", "Drop");
    expect(inputNames(event)).toContain("failedCount");
  });

  // The vault ABIs are pinned to the exact function list. LockVault holds a user's tokens, so "no admin function that
  // can move or release a user's asset" is checked here as data: adding any function, an admin power included, makes
  // this test fail until the new list is reviewed and pasted in deliberately.
  it("lockVaultAbi has exactly these functions and no receive or fallback", () => {
    expect(names(lockVaultAbi, "function").sort()).toEqual(
      [
        "MAX_DURATION",
        "acceptOwnership",
        "extend",
        "initialize",
        "lockedAmount",
        "owner",
        "pendingOwner",
        "token",
        "transferOwnership",
        "unlockAt",
        "withdraw",
      ].sort(),
    );
    expect(hasType(lockVaultAbi, "receive") || hasType(lockVaultAbi, "fallback")).toBe(false);
  });

  it("lockVaultAbi has exactly these events, and the errors the Vault app decodes", () => {
    expect(names(lockVaultAbi, "event").sort()).toEqual(
      ["Extended", "Initialized", "OwnershipTransferStarted", "OwnershipTransferred", "Withdrawn"].sort(),
    );
    const errors = names(lockVaultAbi, "error");
    for (const name of ["BadUnlockTime", "NotOwner", "NotPendingOwner", "StillLocked", "ZeroAddress"]) {
      expect(errors).toContain(name);
    }
  });

  it("vaultFactoryAbi has exactly these functions: locking, the registries with bounded reads, and the allow-list", () => {
    expect(names(vaultFactoryAbi, "function").sort()).toEqual(
      [
        "LOCK_FEE_SHARE_BPS",
        "LOCK_FLAT",
        "LOCK_LP_BPS",
        "acceptOwnership",
        "feeController",
        "isVault",
        "lockPosition",
        "lockToken",
        "lockVaultImpl",
        "managers",
        "owner",
        "pendingOwner",
        "positionVaultImpl",
        "positionVaultsForToken",
        "positionVaultsForTokenLength",
        "positionVaultsForTokenSlice",
        "renounceOwnership",
        "setManager",
        "transferOwnership",
        "vaultsForToken",
        "vaultsForTokenLength",
        "vaultsForTokenSlice",
        "vaultsOf",
        "vaultsOfLength",
        "vaultsOfSlice",
      ].sort(),
    );
    expect(hasType(vaultFactoryAbi, "receive") || hasType(vaultFactoryAbi, "fallback")).toBe(false);
  });

  it("vaultFactoryAbi's slice getters take a start and a count, and its events carry what Inspector reads", () => {
    for (const name of ["vaultsOfSlice", "vaultsForTokenSlice", "positionVaultsForTokenSlice"]) {
      expect(inputNames(findItem(vaultFactoryAbi, "function", name)).slice(1)).toEqual(["start", "count"]);
    }
    expect(names(vaultFactoryAbi, "event").sort()).toEqual(
      ["ManagerSet", "OwnershipTransferStarted", "OwnershipTransferred", "PositionLocked", "TokenLocked"].sort(),
    );
    expect(inputNames(findItem(vaultFactoryAbi, "event", "TokenLocked"))).toEqual([
      "owner",
      "token",
      "vault",
      "amount",
      "fee",
      "unlockAt",
    ]);
    expect(inputNames(findItem(vaultFactoryAbi, "event", "PositionLocked"))).toEqual([
      "owner",
      "manager",
      "tokenId",
      "vault",
      "unlockAt",
    ]);
  });

  it("vaultFactoryAbi has the errors the Vault app decodes", () => {
    const errors = names(vaultFactoryAbi, "error");
    for (const name of ["WrongFee", "FeeTransferFailed", "FeeOutOfRange", "ManagerNotAllowed", "NotAToken", "ZeroAmount"]) {
      expect(errors).toContain(name);
    }
  });

  it("FEE_KEYS.MINT_FLAT matches keccak256(toHex(\"MINT_FLAT\"))", () => {
    expect(FEE_KEYS.MINT_FLAT).toBe(keccak256(toHex("MINT_FLAT")));
  });

  // Each literal below is pinned next to its derivation, independent of abis.ts's own `key()` helper:
  // a re-derivation using the same helper the source uses would happily agree with an accidental
  // rename (e.g. FEE_KEYS.MINT_FLAT quietly changed to key("MINT_FEE")) instead of catching it. A
  // hardcoded literal, computed once and pasted here, can't drift with the source — only a real
  // rename of the string handed to `key(...)` in abis.ts changes what these keys hash to, and either
  // assertion below would then fail immediately.
  describe("FEE_KEYS literals are pinned, so a rename can't silently change a key", () => {
    it("MINT_FLAT", () => {
      expect(keccak256(toBytes("MINT_FLAT"))).toBe("0x7e3109370ea7d535d8e73c700691d5151250527d4c65ccdd66b01e32ec316812");
      expect(FEE_KEYS.MINT_FLAT).toBe("0x7e3109370ea7d535d8e73c700691d5151250527d4c65ccdd66b01e32ec316812");
    });

    it("DROP_PER_RECIPIENT", () => {
      expect(keccak256(toBytes("DROP_PER_RECIPIENT"))).toBe("0x7f20ba24d22838ff3f3d21fdec6fb343e1aca802a9d10ee9d2231b27d83c0125");
      expect(FEE_KEYS.DROP_PER_RECIPIENT).toBe("0x7f20ba24d22838ff3f3d21fdec6fb343e1aca802a9d10ee9d2231b27d83c0125");
    });

    it("DROP_MIN", () => {
      expect(keccak256(toBytes("DROP_MIN"))).toBe("0x3133bb54d476009314a9f209461af209ce01747eddd6f95a3dc60b73f245f8bb");
      expect(FEE_KEYS.DROP_MIN).toBe("0x3133bb54d476009314a9f209461af209ce01747eddd6f95a3dc60b73f245f8bb");
    });
  });
});

// Vesting and ProPass. Each ABI is pinned to its exact function list, like the vault ABIs above: a wallet holds a
// beneficiary's tokens and the factory and ProPass take payments, so any new function, an admin power included, makes
// these tests fail until the new list is reviewed and pasted in deliberately.
describe("vesting and ProPass abis", () => {
  it("arcVestingAbi has exactly OpenZeppelin's vesting wallet functions, and its receive refuses value", () => {
    expect(names(arcVestingAbi, "function").sort()).toEqual(
      [
        "cliff",
        "duration",
        "end",
        "owner",
        "releasable", // releasable(): always 0
        "releasable", // releasable(token)
        "release", // release(): always reverts
        "release", // release(token)
        "released",
        "released",
        "renounceOwnership",
        "start",
        "transferOwnership",
        "vestedAmount",
        "vestedAmount",
      ].sort(),
    );
    expect(hasType(arcVestingAbi, "receive")).toBe(true);
    expect(hasType(arcVestingAbi, "fallback")).toBe(false);
    expect(names(arcVestingAbi, "event").sort()).toEqual(["ERC20Released", "EtherReleased", "OwnershipTransferred"]);
    const errors = names(arcVestingAbi, "error");
    for (const name of ["NativeValueNotSupported", "InvalidCliffDuration", "OwnableUnauthorizedAccount"]) {
      expect(errors).toContain(name);
    }
  });

  it("vestingFactoryAbi has exactly these functions: creation and the registries with bounded reads, no owner", () => {
    expect(names(vestingFactoryAbi, "function").sort()).toEqual(
      [
        "MAX_AMOUNT",
        "MAX_DURATION",
        "VEST_FLAT",
        "createVesting",
        "feeController",
        "isVesting",
        "vestingsForToken",
        "vestingsForTokenLength",
        "vestingsForTokenSlice",
        "vestingsOf",
        "vestingsOfLength",
        "vestingsOfSlice",
      ].sort(),
    );
    expect(hasType(vestingFactoryAbi, "receive") || hasType(vestingFactoryAbi, "fallback")).toBe(false);
    for (const name of ["vestingsOfSlice", "vestingsForTokenSlice"]) {
      expect(inputNames(findItem(vestingFactoryAbi, "function", name)).slice(1)).toEqual(["start", "count"]);
    }
    expect(inputNames(findItem(vestingFactoryAbi, "function", "createVesting"))).toEqual([
      "token",
      "beneficiary",
      "amount",
      "start",
      "duration",
      "cliff",
    ]);
  });

  it("vestingFactoryAbi's VestingCreated event carries what Inspector reads, and the errors the Vesting app decodes", () => {
    expect(names(vestingFactoryAbi, "event")).toEqual(["VestingCreated"]);
    expect(inputNames(findItem(vestingFactoryAbi, "event", "VestingCreated"))).toEqual([
      "creator",
      "token",
      "beneficiary",
      "vesting",
      "amount",
      "start",
      "duration",
      "cliff",
    ]);
    const errors = names(vestingFactoryAbi, "error");
    for (const name of [
      "WrongFee",
      "FeeTransferFailed",
      "BadSchedule",
      "ZeroAmount",
      "AmountTooLarge",
      "NotAToken",
      "ZeroFeeController",
    ]) {
      expect(errors).toContain(name);
    }
  });

  it("proPassAbi has exactly these functions, no receive, and the errors the Pro panel decodes", () => {
    expect(names(proPassAbi, "function").sort()).toEqual(
      ["MAX_MONTHS", "MONTH", "PRO_MONTHLY", "feeController", "isPro", "paidUntil", "subscribe"].sort(),
    );
    expect(hasType(proPassAbi, "receive") || hasType(proPassAbi, "fallback")).toBe(false);
    expect(inputNames(findItem(proPassAbi, "event", "Subscribed"))).toEqual(["account", "payer", "months", "paidUntil"]);
    const errors = names(proPassAbi, "error");
    for (const name of ["BadMonths", "WrongFee", "FeeTransferFailed", "ZeroFeeController"]) {
      expect(errors).toContain(name);
    }
  });
});
