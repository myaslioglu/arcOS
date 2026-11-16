import { erc20Abi, parseEventLogs, type Abi, type Address, type Hex, type Log } from "viem";
import { FEE_KEYS, feeControllerAbi, formatUsdc, lockVaultAbi, positionVaultAbi, vaultFactoryAbi } from "@arcos/chain";
import { UserFacingError } from "@/lib/contract-error";
import { assertWalletOnChain, withChain } from "@/lib/paid-write";
import { POSITION_NFT_ABI } from "@/lib/positions";
import { LOCK_ABI, describeVaultError } from "./errors";

/**
 * Vault's transactions, from the first check to the receipt. Free of React and of wagmi's hooks, so every branch is
 * driven in flow.test.ts against a fake chain and a fake wallet; the window hands it the real ones (useFlowDeps.ts).
 * Every write goes through `withChain`, which pins it to the site's chain; each one is simulated first, so a revert
 * the contract would make costs nothing and reads as a sentence (errors.ts) before the wallet opens.
 */

export type LockPlan =
  | { kind: "token"; token: Address; amount: bigint; unlockAt: number }
  | { kind: "position"; manager: Address; tokenId: bigint; unlockAt: number };

export type LockStep = "approve" | "lock";

export type ContractCall = { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] };
type Receipt = { status: "success" | "reverted"; logs: readonly Log[] };

/** The reads, the simulation and the receipt the flows need, as viem's public client answers them. */
export type FlowClient = {
  readContract: (args: ContractCall) => Promise<unknown>;
  simulateContract: (args: ContractCall & { account: Address; value?: bigint }) => Promise<{ request: object }>;
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<Receipt>;
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
};

export type LockOutcome =
  | { result: "locked"; vault: Address; hash: Hex }
  /** `approvalLeft`: this run set an approval that is still in place, since nothing was locked. */
  | { result: "failed"; message: string; hash?: Hex; approvalLeft: boolean }
  | { result: "unconfirmed"; message: string; hash: Hex };

const UNCONFIRMED_APPROVAL = "The approval was sent, but it isn't confirmed yet. Check the explorer, then lock again.";
const UNCONFIRMED_LOCK = "The lock was sent, but it isn't confirmed yet. Check the explorer before you lock again.";
const LOCK_REVERTED = "The lock reverted. Nothing was locked, and the fee wasn't taken.";
const NO_VAULT = "The transaction went through, but no vault was reported. Check the explorer before you lock again.";

/** The receipt, or null when it couldn't be read: the transaction was sent, and its outcome is unknown. */
async function settle(client: FlowClient, hash: Hex): Promise<Receipt | null> {
  try {
    return await client.waitForTransactionReceipt({ hash });
  } catch {
    return null;
  }
}

/** LOCK_FLAT as the factory will charge it now: from the factory's own FeeController. */
export async function readFlatFee(client: Pick<FlowClient, "readContract">, factory: Address): Promise<bigint> {
  const controller = (await client.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "feeController" })) as Address;
  return (await client.readContract({ address: controller, abi: feeControllerAbi, functionName: "feeOf", args: [FEE_KEYS.LOCK_FLAT] })) as bigint;
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
  const ready = (typeof approved === "string" && approved.toLowerCase() === factory.toLowerCase()) || operator === true;
  return ready ? null : { address: plan.manager, abi: POSITION_NFT_ABI, functionName: "approve", args: [factory, plan.tokenId] };
}

/** The lock call itself, for the wallet as the vault's owner. */
export function lockCall(plan: LockPlan, factory: Address, account: Address): ContractCall {
  return plan.kind === "token"
    ? { address: factory, abi: LOCK_ABI, functionName: "lockToken", args: [plan.token, plan.amount, BigInt(plan.unlockAt), account] }
    : { address: factory, abi: LOCK_ABI, functionName: "lockPosition", args: [plan.manager, plan.tokenId, BigInt(plan.unlockAt), account] };
}

/**
 * The vault the factory reported for this lock: its own TokenLocked or PositionLocked event (a log from any other
 * address in the receipt, a token's for instance, is never read), for this owner and this token or position.
 */
export function vaultFromLogs(logs: readonly Log[], factory: Address, plan: LockPlan, account: Address): Address | null {
  const own = logs.filter((l) => l.address.toLowerCase() === factory.toLowerCase());
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (plan.kind === "token") {
    const [event] = parseEventLogs({ abi: vaultFactoryAbi, logs: own as Log[], eventName: "TokenLocked" }).filter(
      (e) => same(e.args.owner, account) && same(e.args.token, plan.token),
    );
    return event?.args.vault ?? null;
  }
  const [event] = parseEventLogs({ abi: vaultFactoryAbi, logs: own as Log[], eventName: "PositionLocked" }).filter(
    (e) => same(e.args.owner, account) && same(e.args.manager, plan.manager) && e.args.tokenId === plan.tokenId,
  );
  return event?.args.vault ?? null;
}

/**
 * One lock, in this order:
 * 1. the wallet's network is checked (defence in depth; the real guard is `withChain`);
 * 2. the flat fee is read again: one that changed since the form showed it stops here, before the wallet opens;
 * 3. the approval, if the factory hasn't one yet: the exact amount (an ERC-20 or a v2 LP token) or `approve(factory,
 *    tokenId)` (a position), simulated, signed, and confirmed;
 * 4. `lockToken` or `lockPosition` with `value` = the fee, simulated, signed, and confirmed, and the vault read from
 *    the factory's event.
 * `onStep` hears each step as it starts, and again once the wallet has signed it. A transaction sent whose receipt
 * can't be read is "unconfirmed": never reported as failed, which would invite a second, separately charged lock.
 */
export async function runLock(
  plan: LockPlan,
  factory: Address,
  shownFee: bigint,
  deps: FlowDeps,
  onStep?: (step: LockStep, sent: boolean) => void,
): Promise<LockOutcome> {
  const { client, account } = deps;
  let approvalLeft = false;
  try {
    assertWalletOnChain(deps.walletChainId, deps.chainId);
    const fee = await readFlatFee(client, factory);
    if (fee !== shownFee) throw new UserFacingError(`The lock fee changed to ${formatUsdc(fee)} USDC. Check it and lock again.`);

    const approval = await approvalFor(plan, factory, account, client);
    if (approval) {
      onStep?.("approve", false);
      const { request } = await client.simulateContract({ ...approval, account });
      const hash = await deps.writeContractAsync(withChain(request, deps.chainId) as never);
      onStep?.("approve", true);
      const receipt = await settle(client, hash);
      if (!receipt) return { result: "unconfirmed", message: UNCONFIRMED_APPROVAL, hash };
      if (receipt.status === "reverted") return { result: "failed", message: "The approval reverted, so nothing was locked.", hash, approvalLeft: false };
      approvalLeft = true;
    }

    onStep?.("lock", false);
    const { request } = await client.simulateContract({ ...lockCall(plan, factory, account), account, value: fee });
    const hash = await deps.writeContractAsync(withChain(request, deps.chainId) as never);
    onStep?.("lock", true);
    const receipt = await settle(client, hash);
    if (!receipt) return { result: "unconfirmed", message: UNCONFIRMED_LOCK, hash };
    if (receipt.status === "reverted") return { result: "failed", message: LOCK_REVERTED, hash, approvalLeft };
    const vault = vaultFromLogs(receipt.logs, factory, plan, account);
    if (!vault) return { result: "unconfirmed", message: NO_VAULT, hash };
    return { result: "locked", vault, hash };
  } catch (err) {
    return { result: "failed", message: describeVaultError(err), approvalLeft };
  }
}

export type VaultAction =
  | { kind: "extend"; unlockAt: number }
  | { kind: "collect" }
  | { kind: "withdraw" }
  /** `to` = the zero address cancels a transfer that is waiting. */
  | { kind: "transfer"; to: Address }
  | { kind: "accept" };

/** One currency a collect paid out: to the owner, and to ArcOS (or skipped, when paying ArcOS failed). */
export type Collected = { currency: Address; toOwner: bigint; toPlatform: bigint };

export type ActionOutcome =
  | { result: "done"; hash: Hex; collected: Collected[] }
  | { result: "failed"; message: string; hash?: Hex }
  | { result: "unconfirmed"; message: string; hash: Hex };

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
    case "accept":
      return { ...base, functionName: "acceptOwnership", args: [] };
  }
}

/** What a collect paid, from the vault's own Collected events. */
export function collectedFromLogs(logs: readonly Log[], vault: Address): Collected[] {
  const own = logs.filter((l) => l.address.toLowerCase() === vault.toLowerCase());
  return parseEventLogs({ abi: positionVaultAbi, logs: own as Log[], eventName: "Collected" }).map((e) => ({
    currency: e.args.currency,
    toOwner: e.args.toOwner,
    toPlatform: e.args.toPlatform,
  }));
}

/** One action on one vault: checked, simulated, signed through `withChain`, and confirmed. */
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
    const hash = await deps.writeContractAsync(withChain(request, deps.chainId) as never);
    onSent?.();
    const receipt = await settle(client, hash);
    if (!receipt) return { result: "unconfirmed", message: "The transaction was sent, but it isn't confirmed yet. Check the explorer.", hash };
    if (receipt.status === "reverted") return { result: "failed", message: "The transaction reverted. The vault is unchanged.", hash };
    return { result: "done", hash, collected: action.kind === "collect" ? collectedFromLogs(receipt.logs, vault.vault) : [] };
  } catch (err) {
    return { result: "failed", message: describeVaultError(err) };
  }
}
