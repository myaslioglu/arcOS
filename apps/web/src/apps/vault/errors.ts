import { FEE_KEYS, formatUsdc, lockVaultAbi, positionVaultAbi, vaultFactoryAbi } from "@arcos/chain";
import { describeContractError, type ErrorFormatter } from "@/lib/contract-error";
import { POSITION_ISSUE } from "@/lib/positions";
import { bpsText } from "./fees";
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
const NOTHING_TAKEN = "Nothing was locked and no fee was taken. Check it and lock again.";

/**
 * FeeAboveMax(key, current, max): ArcOS's share rose above the most this lock accepted (the share the form showed, sent
 * as `maxFeeBps`), after the form read it: in the simulation, or just before the lock was mined. Which share, and to
 * what. A maximum of 0 on the LP share is a token the form didn't take for a v2 pair that answered as one when the lock
 * ran.
 */
function feeAboveMax(a: readonly unknown[]): string {
  const key = typeof a[0] === "string" ? a[0].toLowerCase() : null;
  const current = asBigInt(a[1]);
  const max = asBigInt(a[2]);
  if (key === FEE_KEYS.LOCK_LP_BPS.toLowerCase()) {
    if (max === 0n) return `This token turned out to be a Uniswap v2 LP token, which pays ArcOS a share of ${bpsText(current)} that this lock didn't accept. ${NOTHING_TAKEN}`;
    return `ArcOS's share of an LP token lock rose to ${bpsText(current)}, above the ${bpsText(max)} this lock accepted. ${NOTHING_TAKEN}`;
  }
  if (key === FEE_KEYS.LOCK_FEE_SHARE_BPS.toLowerCase()) {
    return `ArcOS's share of collected fees rose to ${bpsText(current)}, above the ${bpsText(max)} this lock accepted. ${NOTHING_TAKEN}`;
  }
  return `ArcOS's share rose above what this lock accepted. ${NOTHING_TAKEN}`;
}
/** Also said before signing, for a manager the factory doesn't allow. */
export const MANAGER_NOT_ALLOWED = "Vault doesn't take positions from this manager.";
const SET_UP = "This vault was already set up.";

export const VAULT_ERRORS: Readonly<Record<string, ErrorFormatter>> = {
  // --- VaultFactory ---
  FailedDeployment: () => NOT_CREATED,
  InsufficientBalance: () => NOT_CREATED,
  FeeAboveMax: feeAboveMax,
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

/** Whether `err`, or anything in its `cause` chain, is one of the errors `names` (viem's and wagmi's class names). */
function isNamed(err: unknown, names: readonly string[]): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { name?: unknown; cause?: unknown };
    if (typeof e.name === "string" && names.includes(e.name)) return true;
    current = e.cause;
  }
  return false;
}

export const WRONG_NETWORK = "Your wallet is on a different network. Switch to Arc and try again.";
export const NOT_CONNECTED = "Your wallet isn't connected. Connect it and try again.";

/**
 * One plain sentence for a failed Vault transaction: the wallet on another network or not connected (nothing was
 * sent), then the vault's own sentence for its errors, else the shared ones.
 */
export function describeVaultError(err: unknown): string {
  if (isNamed(err, ["ChainMismatchError", "ConnectorChainMismatchError"])) return WRONG_NETWORK;
  if (isNamed(err, ["AccountNotFoundError", "ConnectorAccountNotFoundError", "ConnectorNotConnectedError", "ConnectorUnavailableReconnectingError"])) {
    return NOT_CONNECTED;
  }
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
