import { erc20Abi, parseEventLogs, zeroAddress, type Abi, type Address, type Hex, type Log } from "viem";
import { FEE_KEYS, feeControllerAbi, formatUsdc, lockVaultAbi, positionVaultAbi, vaultFactoryAbi } from "@arcos/chain";
import { UserFacingError, wasNotSent } from "@/lib/contract-error";
import { assertWalletOnChain, withChain } from "@/lib/paid-write";
import { POSITION_NFT_ABI } from "@/lib/positions";
import { LOCK_ABI, describeVaultError } from "./errors";
import { bpsText, type FeeAmounts } from "./fees";

/**
 * Vault's transactions, from the first check to the receipt. Free of React and of wagmi's hooks, so every branch is
 * driven in flow.test.ts against a fake chain and a fake wallet; the window hands it the real ones (hooks.ts's
 * useFlowDeps). Every write goes through `withChain`, which pins it to the site's chain; each one is simulated first,
 * so a revert the contract would make costs nothing and reads as a sentence (errors.ts) before the wallet opens.
 *
 * A transaction counts as done only on what the chain says: a successful receipt and, in it, the event the call
 * emits with the arguments it was sent with (a cancelled or replaced transaction comes back with a successful receipt
 * that did nothing), or for an approval the allowance read again. A wallet error that shows nothing was sent (a
 * refusal, a wrong network, no connection, a balance too low) is a plain failure. Any other may have come after the
 * transaction went out (a phone wallet's lost reply), so it is never offered for a blind retry: for a lock, which
 * costs a fee, the chain is read for it for about a minute, and without it the outcome is unknown.
 */

export type LockPlan =
  /** `pair`: the token is shaped like a Uniswap v2 pair (fees.ts's isV2PairShape), so the factory takes the LP share. */
  | { kind: "token"; token: Address; amount: bigint; unlockAt: number; pair: boolean }
  | { kind: "position"; manager: Address; tokenId: bigint; unlockAt: number };

/** "find": the wallet answered with an error after the lock may have gone out, and the chain is read for it. */
export type LockStep = "approve" | "lock" | "find";

export type ContractCall = { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] };
type Receipt = { status: "success" | "reverted"; logs: readonly Log[]; to?: Address | null };
/** TokenLocked's or PositionLocked's arguments, as viem's getContractEvents decodes them. */
type FactoryEventArgs = { vault?: Address; token?: Address; manager?: Address; tokenId?: bigint; amount?: bigint; fee?: bigint; unlockAt?: bigint };
type FactoryEvent = { transactionHash: Hex | null; args: FactoryEventArgs };

/** The reads, the simulation and the receipt the flows need, as viem's public client answers them. */
export type FlowClient = {
  readContract: (args: ContractCall) => Promise<unknown>;
  simulateContract: (args: ContractCall & { account: Address; value?: bigint }) => Promise<{ request: object }>;
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<Receipt>;
  getBlockNumber: () => Promise<bigint>;
  getContractEvents: (args: { address: Address; abi: Abi | readonly unknown[]; eventName: string; args?: object; fromBlock: bigint }) => Promise<readonly FactoryEvent[]>;
};

export type FlowDeps = {
  client: FlowClient;
  /** The connected wallet: it signs, and it owns what it locks. */
  account: Address;
  /** The chain the site runs on, and the one the wallet says it is on. */
  chainId: number;
  walletChainId: number | undefined;
  /** wagmi's writeContractAsync. The flows call it only through `withChain`. */
  writeContractAsync: (request: never) => Promise<Hex>;
  /** The wait between looks for a lock whose reply was lost; a timer unless a test passes its own. */
  wait?: (ms: number) => Promise<void>;
};

export type LockOutcome =
  /** `amount`: for a token, what reached the vault, from the factory's TokenLocked event. */
  | { result: "locked"; vault: Address; hash: Hex; amount?: bigint }
  /** `approvalLeft`: this run set an approval that is still in place, since nothing was locked. */
  | { result: "failed"; message: string; hash?: Hex; approvalLeft: boolean }
  /** The lock may have happened: never "try again" without a look first. No hash when the wallet never gave one. */
  | { result: "unconfirmed"; message: string; hash?: Hex };

const UNCONFIRMED_APPROVAL = "The approval was sent, but it isn't confirmed yet. Check the explorer, then lock again.";
const UNCONFIRMED_LOCK = "The lock was sent, but it isn't confirmed yet. Check the explorer before you lock again.";
const UNKNOWN_LOCK = "Your wallet answered with an error, and no new lock showed up on chain within a minute. Check Your locks before you lock again.";
const LOCK_REVERTED = "The lock reverted. Nothing was locked, and the fee wasn't taken.";
const NO_VAULT = "The transaction went through, but no vault was reported. Check the explorer before you lock again.";
const APPROVAL_NOT_SET = "The approval didn't take effect, so nothing was locked. Try again.";

/** A lock whose reply was lost is looked for FIND_TRIES times, FIND_EVERY_MS apart: about a minute. */
export const FIND_TRIES = 15;
export const FIND_EVERY_MS = 4_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The receipt, or null when it couldn't be read: the transaction was sent, and its outcome is unknown. */
async function settle(client: FlowClient, hash: Hex): Promise<Receipt | null> {
  try {
    return await client.waitForTransactionReceipt({ hash });
  } catch {
    return null;
  }
}

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** The lock fees as the factory will charge them now: from the factory's own FeeController. */
export async function readLockFees(client: Pick<FlowClient, "readContract">, factory: Address): Promise<FeeAmounts> {
  const controller = (await client.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "feeController" })) as Address;
  const fee = (key: Hex) => client.readContract({ address: controller, abi: feeControllerAbi, functionName: "feeOf", args: [key] }) as Promise<bigint>;
  const [flat, lpBps, shareBps] = await Promise.all([fee(FEE_KEYS.LOCK_FLAT), fee(FEE_KEYS.LOCK_LP_BPS), fee(FEE_KEYS.LOCK_FEE_SHARE_BPS)]);
  return { flat, lpBps, shareBps };
}

/**
 * Why the lock stops before the wallet opens, or null: a fee this plan pays that isn't the one the form showed any
 * more. The flat fee always; the LP share for a token shaped like a v2 pair; for a position, the share of collected
 * fees, which the vault keeps for life.
 */
export function feeChange(plan: LockPlan, shown: FeeAmounts, now: FeeAmounts): UserFacingError | null {
  if (now.flat !== shown.flat) return new UserFacingError(`The lock fee changed to ${formatUsdc(now.flat)} USDC. Check it and lock again.`);
  if (plan.kind === "token" && plan.pair && now.lpBps !== shown.lpBps) {
    return new UserFacingError(`ArcOS's share of an LP token lock changed to ${bpsText(now.lpBps)}. Check it and lock again.`);
  }
  if (plan.kind === "position" && now.shareBps !== shown.shareBps) {
    return new UserFacingError(`ArcOS's share of collected fees changed to ${bpsText(now.shareBps)}. Check it and lock again.`);
  }
  return null;
}

/** The approval a plan needs, or null when the factory may already take it. Exact: the amount, or this one position. */
export async function approvalFor(plan: LockPlan, factory: Address, account: Address, client: Pick<FlowClient, "readContract">): Promise<ContractCall | null> {
  if (plan.kind === "token") {
    const allowance = (await client.readContract({ address: plan.token, abi: erc20Abi, functionName: "allowance", args: [account, factory] })) as bigint;
    return allowance >= plan.amount ? null : { address: plan.token, abi: erc20Abi, functionName: "approve", args: [factory, plan.amount] };
  }
  const [approved, operator] = await Promise.all([
    client.readContract({ address: plan.manager, abi: POSITION_NFT_ABI, functionName: "getApproved", args: [plan.tokenId] }),
    client.readContract({ address: plan.manager, abi: POSITION_NFT_ABI, functionName: "isApprovedForAll", args: [account, factory] }),
  ]);
  return same(approved, factory) || operator === true
    ? null
    : { address: plan.manager, abi: POSITION_NFT_ABI, functionName: "approve", args: [factory, plan.tokenId] };
}

/** The lock call itself, for the wallet as the vault's owner. */
export function lockCall(plan: LockPlan, factory: Address, account: Address): ContractCall {
  return plan.kind === "token"
    ? { address: factory, abi: LOCK_ABI, functionName: "lockToken", args: [plan.token, plan.amount, BigInt(plan.unlockAt), account] }
    : { address: factory, abi: LOCK_ABI, functionName: "lockPosition", args: [plan.manager, plan.tokenId, BigInt(plan.unlockAt), account] };
}

/**
 * The lock the factory reported in this receipt: its own TokenLocked or PositionLocked event (a log from any other
 * address in the receipt, a token's for instance, is never read) for this owner, this token or position and this
 * unlock time. For a token, `amount` is what reached the vault: the factory records what arrived, so a token that
 * takes a cut on transfer, or the LP share, shows in it.
 */
export function lockedFromLogs(logs: readonly Log[], factory: Address, plan: LockPlan, account: Address): { vault: Address; amount?: bigint } | null {
  const own = logs.filter((l) => same(l.address, factory));
  const unlockAt = BigInt(plan.unlockAt);
  if (plan.kind === "token") {
    const [event] = parseEventLogs({ abi: vaultFactoryAbi, logs: own as Log[], eventName: "TokenLocked" }).filter(
      (e) => same(e.args.owner, account) && same(e.args.token, plan.token) && e.args.unlockAt === unlockAt,
    );
    return event ? { vault: event.args.vault, amount: event.args.amount } : null;
  }
  const [event] = parseEventLogs({ abi: vaultFactoryAbi, logs: own as Log[], eventName: "PositionLocked" }).filter(
    (e) => same(e.args.owner, account) && same(e.args.manager, plan.manager) && e.args.tokenId === plan.tokenId && e.args.unlockAt === unlockAt,
  );
  return event ? { vault: event.args.vault } : null;
}

/**
 * Whether a factory event reports this plan's lock exactly: the token and the whole amount (what reached the vault
 * plus the LP share), or the manager and the position's id, and the unlock time.
 */
function isThisLock(args: FactoryEventArgs, plan: LockPlan): boolean {
  if (args.unlockAt !== BigInt(plan.unlockAt)) return false;
  if (plan.kind === "token") {
    return same(args.token, plan.token) && typeof args.amount === "bigint" && typeof args.fee === "bigint" && args.amount + args.fee === plan.amount;
  }
  return same(args.manager, plan.manager) && args.tokenId === plan.tokenId;
}

/**
 * After a wallet error that may have followed the lock's sending: the lock, if the factory's registry now lists a new
 * vault for the wallet that is this one. Anyone can lock any token for any owner, so a new vault counts only when the
 * factory's event for it reports this plan exactly (isThisLock) and the vault itself holds that token or position
 * until that time. A token that takes a cut on transfer reports less than it was sent, so its lock is left for the
 * wallet to check (null). Null too when nothing could be read.
 */
export async function findLocked(
  client: FlowClient,
  factory: Address,
  plan: LockPlan,
  account: Address,
  before: bigint,
  fromBlock: bigint,
): Promise<{ vault: Address; hash: Hex; amount?: bigint } | null> {
  try {
    const after = (await client.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "vaultsOfLength", args: [account] })) as bigint;
    if (after <= before) return null;
    const added = (await client.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "vaultsOfSlice", args: [account, before, after - before] })) as Address[];
    const events = await client.getContractEvents({
      address: factory,
      abi: vaultFactoryAbi,
      eventName: plan.kind === "token" ? "TokenLocked" : "PositionLocked",
      args: { owner: account },
      fromBlock,
    });
    const read = (address: Address, abi: Abi | readonly unknown[], functionName: string) => client.readContract({ address, abi, functionName }).catch(() => null);
    for (const vault of added) {
      const event = events.find((e) => same(e.args.vault, vault) && isThisLock(e.args, plan));
      if (!event?.transactionHash) continue;
      if ((await read(vault, plan.kind === "token" ? lockVaultAbi : positionVaultAbi, "unlockAt")) !== BigInt(plan.unlockAt)) continue;
      const holds =
        plan.kind === "token"
          ? same(await read(vault, lockVaultAbi, "token"), plan.token)
          : same(await read(vault, positionVaultAbi, "manager"), plan.manager) && (await read(vault, positionVaultAbi, "tokenId")) === plan.tokenId;
      if (!holds) continue;
      return plan.kind === "token" ? { vault, hash: event.transactionHash, amount: event.args.amount } : { vault, hash: event.transactionHash };
    }
    return null;
  } catch {
    return null;
  }
}

/** findLocked, read again every FIND_EVERY_MS until it finds the lock or FIND_TRIES reads are done: about a minute. */
export async function pollLocked(
  client: FlowClient,
  factory: Address,
  plan: LockPlan,
  account: Address,
  before: bigint,
  fromBlock: bigint,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<{ vault: Address; hash: Hex; amount?: bigint } | null> {
  for (let i = 0; i < FIND_TRIES; i++) {
    if (i > 0) await wait(FIND_EVERY_MS);
    const found = await findLocked(client, factory, plan, account, before, fromBlock);
    if (found) return found;
  }
  return null;
}

/**
 * One lock, in this order:
 * 1. the wallet's network is checked (defence in depth; the real guard is `withChain`);
 * 2. the fees are read again: a fee this lock pays that changed since the form showed it (`shown`) stops here, before
 *    the wallet opens (feeChange);
 * 3. the approval, if the factory hasn't one yet: the exact amount (an ERC-20 or a v2 LP token) or `approve(factory,
 *    tokenId)` (a position), simulated, signed, confirmed, and read again;
 * 4. the fees once more, since an approval can take minutes; then `lockToken` or `lockPosition` with `value` = the
 *    flat fee, simulated, signed, and confirmed, and the vault read from the factory's event.
 * `onStep` hears each step as it starts, and again once the wallet has signed it. A lock sent whose outcome can't be
 * read is "unconfirmed": never reported as failed, which would invite a second, separately charged lock.
 */
export async function runLock(
  plan: LockPlan,
  factory: Address,
  shown: FeeAmounts,
  deps: FlowDeps,
  onStep?: (step: LockStep, sent: boolean) => void,
): Promise<LockOutcome> {
  const { client, account } = deps;
  let approvalLeft = false;
  const checkFees = async (): Promise<bigint> => {
    const changed = feeChange(plan, shown, await readLockFees(client, factory));
    if (changed) throw changed;
    return shown.flat;
  };
  try {
    assertWalletOnChain(deps.walletChainId, deps.chainId);
    await checkFees();

    const approval = await approvalFor(plan, factory, account, client);
    if (approval) {
      onStep?.("approve", false);
      const { request } = await client.simulateContract({ ...approval, account });
      let hash: Hex | null = null;
      try {
        hash = await deps.writeContractAsync(withChain(request, deps.chainId) as never);
      } catch (err) {
        // Nothing sent is the end. Any other error may have come after the approval was sent: what the chain now holds
        // decides, and a second approval of the same amount costs gas only.
        if (wasNotSent(err) || (await approvalFor(plan, factory, account, client))) throw err;
      }
      if (hash) {
        onStep?.("approve", true);
        const receipt = await settle(client, hash);
        if (!receipt) return { result: "unconfirmed", message: UNCONFIRMED_APPROVAL, hash };
        if (receipt.status === "reverted") return { result: "failed", message: "The approval reverted, so nothing was locked.", hash, approvalLeft: false };
        // A cancelled or replaced approval comes back successful too: the allowance itself says whether it is set.
        if (await approvalFor(plan, factory, account, client)) return { result: "failed", message: APPROVAL_NOT_SET, hash, approvalLeft: false };
      }
      approvalLeft = true;
    }

    onStep?.("lock", false);
    const fee = await checkFees();
    const { request } = await client.simulateContract({ ...lockCall(plan, factory, account), account, value: fee });
    // What the registry holds now, to look for this lock in if the wallet's answer is lost after sending.
    const fromBlock = await client.getBlockNumber();
    const before = (await client.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "vaultsOfLength", args: [account] })) as bigint;
    let hash: Hex;
    try {
      hash = await deps.writeContractAsync(withChain(request, deps.chainId) as never);
    } catch (err) {
      if (wasNotSent(err)) throw err;
      onStep?.("find", false);
      const found = await pollLocked(client, factory, plan, account, before, fromBlock, deps.wait);
      return found ? { result: "locked", ...found } : { result: "unconfirmed", message: UNKNOWN_LOCK };
    }
    onStep?.("lock", true);
    const receipt = await settle(client, hash);
    if (!receipt) return { result: "unconfirmed", message: UNCONFIRMED_LOCK, hash };
    if (receipt.status === "reverted") return { result: "failed", message: LOCK_REVERTED, hash, approvalLeft };
    const locked = lockedFromLogs(receipt.logs, factory, plan, account);
    if (!locked) return { result: "unconfirmed", message: NO_VAULT, hash };
    return { result: "locked", ...locked, hash };
  } catch (err) {
    return { result: "failed", message: describeVaultError(err), approvalLeft };
  }
}

export type VaultAction =
  | { kind: "extend"; unlockAt: number }
  | { kind: "collect" }
  | { kind: "withdraw" }
  | { kind: "transfer"; to: Address }
  /** Cancels a handover that is waiting: `transferOwnership(address(0))`. */
  | { kind: "cancel" }
  | { kind: "accept" };

/** One currency a collect paid out: to the owner, and to ArcOS (or skipped, when paying ArcOS failed). */
export type Collected = { currency: Address; toOwner: bigint; toPlatform: bigint };

export type ActionOutcome =
  | { result: "done"; hash: Hex; collected: Collected[] }
  | { result: "failed"; message: string; hash?: Hex }
  /** It may have happened: the list is read again, and the vault says. No hash when the wallet never gave one. */
  | { result: "unconfirmed"; message: string; hash?: Hex };

/** The call an action makes on the vault. Withdraw always sends to the wallet itself, which must be the owner. */
export function actionCall(vault: { vault: Address; kind: "token" | "position" }, action: VaultAction, account: Address): ContractCall {
  const abi = vault.kind === "token" ? lockVaultAbi : positionVaultAbi;
  const base = { address: vault.vault, abi };
  switch (action.kind) {
    case "extend":
      return { ...base, functionName: "extend", args: [BigInt(action.unlockAt)] };
    case "collect":
      if (vault.kind !== "position") throw new UserFacingError("Only a position's vault collects fees.");
      return { ...base, functionName: "collect", args: [] };
    case "withdraw":
      return { ...base, functionName: "withdraw", args: [account] };
    case "transfer":
      return { ...base, functionName: "transferOwnership", args: [action.to] };
    case "cancel":
      return { ...base, functionName: "transferOwnership", args: [zeroAddress] };
    case "accept":
      return { ...base, functionName: "acceptOwnership", args: [] };
  }
}

/**
 * The event each action's vault emits, which a receipt must carry from that vault, with the action's own arguments, to
 * count. A collect emits one per currency paid, and none when there was nothing to collect, so it needs none: its
 * receipt must be the vault's call.
 */
export const ACTION_EVENT: Record<VaultAction["kind"], string | null> = {
  extend: "Extended",
  collect: null,
  withdraw: "Withdrawn",
  transfer: "OwnershipTransferStarted",
  cancel: "OwnershipTransferStarted",
  accept: "OwnershipTransferred",
};

/**
 * Whether `receipt` is the action's own: sent to the vault, and carrying the vault's event for it with what was asked:
 * the new unlock time, a withdrawal to the wallet, the handover to `to` (to no one, for a cancel), the wallet as the
 * new owner.
 */
export function actionHappened(receipt: Receipt, vault: { vault: Address; kind: "token" | "position" }, action: VaultAction, account: Address): boolean {
  if (receipt.to !== undefined && receipt.to !== null && !same(receipt.to, vault.vault)) return false;
  const eventName = ACTION_EVENT[action.kind];
  if (!eventName) return true;
  const abi = (vault.kind === "token" ? lockVaultAbi : positionVaultAbi) as Abi;
  const own = receipt.logs.filter((l) => same(l.address, vault.vault));
  const events = parseEventLogs({ abi, logs: own as Log[], eventName: eventName as never }) as unknown as { args: Record<string, unknown> }[];
  return events.some(({ args }) => {
    switch (action.kind) {
      case "extend":
        return args.unlockAt === BigInt(action.unlockAt);
      case "transfer":
        return same(args.to, action.to);
      case "cancel":
        return same(args.to, zeroAddress);
      default:
        // Withdrawn and OwnershipTransferred both name the wallet: what was withdrawn went to it, and it is the owner.
        return same(args.to, account);
    }
  });
}

/** What a collect paid, from the vault's own Collected events. */
export function collectedFromLogs(logs: readonly Log[], vault: Address): Collected[] {
  const own = logs.filter((l) => same(l.address, vault));
  return parseEventLogs({ abi: positionVaultAbi, logs: own as Log[], eventName: "Collected" }).map((e) => ({
    currency: e.args.currency,
    toOwner: e.args.toOwner,
    toPlatform: e.args.toPlatform,
  }));
}

/** One action on one vault: checked, simulated, signed through `withChain`, and confirmed by its receipt and event. */
export async function runAction(
  vault: { vault: Address; kind: "token" | "position" },
  action: VaultAction,
  deps: FlowDeps,
  onSent?: () => void,
): Promise<ActionOutcome> {
  const { client, account } = deps;
  try {
    assertWalletOnChain(deps.walletChainId, deps.chainId);
    const { request } = await client.simulateContract({ ...actionCall(vault, action, account), account });
    let hash: Hex;
    try {
      hash = await deps.writeContractAsync(withChain(request, deps.chainId) as never);
    } catch (err) {
      if (wasNotSent(err)) throw err;
      return { result: "unconfirmed", message: "Your wallet answered with an error, so the transaction may or may not have been sent. Check the vault before you try again." };
    }
    onSent?.();
    const receipt = await settle(client, hash);
    if (!receipt) return { result: "unconfirmed", message: "The transaction was sent, but it isn't confirmed yet. Check the explorer.", hash };
    if (receipt.status === "reverted") return { result: "failed", message: "The transaction reverted. The vault is unchanged.", hash };
    if (!actionHappened(receipt, vault, action, account)) {
      return { result: "unconfirmed", message: "The transaction went through, but the vault didn't report the change. Check the vault before you try again.", hash };
    }
    return { result: "done", hash, collected: action.kind === "collect" ? collectedFromLogs(receipt.logs, vault.vault) : [] };
  } catch (err) {
    return { result: "failed", message: describeVaultError(err) };
  }
}
