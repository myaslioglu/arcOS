import { formatUsdc, lockVaultAbi, positionVaultAbi, vaultFactoryAbi } from "@arcos/chain";
import { describeContractError, type ErrorFormatter } from "@/lib/contract-error";
import { POSITION_ISSUE } from "@/lib/positions";
import { formatWhen } from "./lockForm";

/**
 * A plain sentence for every custom error the VaultFactory, LockVault and PositionVault declare, read before the
 * shared map in lib/contract-error.ts: some names there mean something else here (Multisend's ZeroAmount is a row of
 * a batch; the factory's is a lock that would deliver nothing). Covered by the ABI-completeness test in
 * __tests__/errors.test.ts. What can be predicted is said before signing (the form's checks and positionIssue);
 * these are for what the simulation or the receipt reverts with.
 */
const asBigInt = (v: unknown): bigint => {
  if (typeof v !== "bigint") throw new Error("expected a bigint revert argument");
  return v;
};

const NOT_CREATED = "The vault couldn't be created, so nothing was locked. Try again.";
/** Also said before signing, for a manager the factory doesn't allow. */
export const MANAGER_NOT_ALLOWED = "Vault doesn't take positions from this manager.";
const SET_UP = "This vault was already set up.";

export const VAULT_ERRORS: Readonly<Record<string, ErrorFormatter>> = {
  // --- VaultFactory ---
  FailedDeployment: () => NOT_CREATED,
  InsufficientBalance: () => NOT_CREATED,
  FeeOutOfRange: () => "One of the lock fees is set out of range, so locks are paused. Try again later.",
  FeeTransferFailed: () => "The fee couldn't be sent to ArcOS's fee recipient, so nothing was locked. Try again later.",
  HookedPool: () => POSITION_ISSUE.hooked,
  ManagerNotAllowed: () => MANAGER_NOT_ALLOWED,
  NoLiquidity: () => POSITION_ISSUE.noLiquidity,
  NotAToken: () => "That address isn't a token contract.",
  OwedNotCollected: () => POSITION_ISSUE.owed,
  OwnableInvalidOwner: () => "That address can't be the owner.",
  OwnableUnauthorizedAccount: () => "You don't have permission to do that.",
  PositionNotReceived: () => "The vault didn't receive the position, so nothing was locked.",
  RenounceDisabled: () => "Ownership can't be given up on this contract, only transferred.",
  WrongFee: (a) => `The lock fee changed while you were signing. It is now ${formatUsdc(asBigInt(a[0]))} USDC. Check it and lock again.`,
  ZeroAmount: () => "Nothing would reach the vault: the amount is zero, or the token sent nothing.",
  ZeroFeeController: () => "The fee controller address can't be zero.",

  // --- Shared by the factory and both vaults ---
  ReentrancyGuardReentrantCall: () => "That action is already in progress.",
  SafeERC20FailedOperation: () => "The token refused the transfer. Check your balance and the approval, then try again.",

  // --- LockVault and PositionVault ---
  BadUnlockTime: () => "The unlock date must be in the future, at most 10 years from now, and later than the current one.",
  InvalidInitialization: () => SET_UP,
  NotInitializing: () => SET_UP,
  NotOwner: () => "Only the vault's owner can do that.",
  NotPendingOwner: () => "Only the wallet this vault is being handed to can accept it.",
  StillLocked: (a) => `This vault is locked until ${formatWhen(Number(asBigInt(a[0])))}.`,
  ZeroAddress: () => "The address can't be the zero address.",

  // --- PositionVault ---
  BadFeeShare: () => "The fee share is out of range.",
  InsufficientGas: () => "The transaction ran short of gas. Try again with a higher gas limit.",
  NativeNotAccepted: () => "This vault doesn't accept USDC sent to it.",
  NativeTransferFailed: () => "Your wallet couldn't receive the fees in USDC. Collect from a wallet that can receive USDC.",
  UnexpectedNft: () => "This vault only takes the position it was made for.",
};

/** One plain sentence for a failed Vault transaction: the vault's own sentence for its errors, else the shared ones. */
export function describeVaultError(err: unknown): string {
  return describeContractError(err, VAULT_ERRORS);
}

type AbiItem = (typeof vaultFactoryAbi)[number] | (typeof lockVaultAbi)[number] | (typeof positionVaultAbi)[number];

/**
 * The factory's ABI with the vaults' errors added. A lock call runs the new vault's `initialize` inside it, so a bad
 * unlock time reverts with the vault's `BadUnlockTime`, which the factory's ABI alone can't decode: simulating and
 * sending through this one lets viem name it, and `describeVaultError` say it.
 */
export const LOCK_ABI: readonly AbiItem[] = [
  ...vaultFactoryAbi,
  ...[...lockVaultAbi, ...positionVaultAbi].filter(
    (item, i, all) =>
      item.type === "error" &&
      !vaultFactoryAbi.some((f) => f.type === "error" && f.name === item.name) &&
      all.findIndex((other) => other.type === "error" && other.name === item.name) === i,
  ),
];
