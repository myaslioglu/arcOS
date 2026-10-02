import type { Address, Hex } from "viem";
import type { Approval } from "@/lib/approvals";
import { trackEvent } from "@/lib/analytics";
import { UserFacingError } from "@/lib/contract-error";
import { assertWalletOnChain, withChain } from "@/lib/paid-write";
import { markRevoked, nodeHasSeenApproval, revokeFailure, rowKey, type RevokeStage } from "./rows";
import { liveRead, readState, revokeWrite, type ContractCall } from "./tx";

/**
 * One revoke transaction, from the first check to the last read. Free of React and of wagmi's hooks, so every branch is
 * driven in flow.test.ts against a fake chain and a fake wallet; Window.tsx hands it the real ones.
 */

/** The reads and the simulate the flow needs, as viem's public client answers them. */
export type RevokeClient = {
  getBlockNumber: (args: { cacheTime: 0 }) => Promise<bigint>;
  readContract: (args: ContractCall & { blockNumber: bigint }) => Promise<unknown>;
  simulateContract: (args: ContractCall & { account: Address }) => Promise<{ request: object }>;
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
};

export type RevokeDeps = {
  client: RevokeClient;
  /** Whose approvals: the connected wallet's own (Window.tsx offers Revoke for nothing else). */
  owner: Address;
  account: Address;
  /** The chain the site runs on, and the one the wallet says it is on. */
  chainId: number;
  walletChainId: number | undefined;
  /** wagmi's writeContractAsync. The flow calls it only through `withChain`, which pins the transaction's chain. */
  writeContractAsync: (request: never) => Promise<Hex>;
  /** Hears the hash once the wallet has signed and sent, before the receipt is awaited (the window's label changes). */
  onSent?: (hash: Hex) => void;
};

/** How one row came out: revoked (at a block), confirmed but still set (and what is left), or failed. */
export type RowOutcome =
  | { key: string; result: "revoked"; block: number }
  | { key: string; result: "still-set"; left: string; hash: string }
  | { key: string; result: "failed"; text: string; hash?: string };

/**
 * Revokes `rows` in one transaction (one row, or several Permit2 pairs; see tx.ts), in this order:
 * 1. the wallet's network is checked before anything is read (defence in depth; the real guard is `withChain`);
 * 2. the head is read live, and each row is read at it. The server keeps an owner's list for 60 s, so a row can be
 *    revoked already; one that reads cleared from a node that has reached its approval's block is marked revoked
 *    with no transaction. A node behind that block may not have seen the approval yet, so its "cleared" isn't
 *    believed and the row goes on to the wallet: a costly no-op at worst, never a live approval hidden as revoked;
 * 3. the rest are simulated, then sent through `withChain` (`onSent` hears the hash), and the receipt is awaited. A
 *    revert throws;
 * 4. each is read again at the receipt's block: cleared is revoked, anything else is still set.
 * A revoke is counted (`revoke_success`) once per confirmed transaction that cleared something. Every failure lands on
 * each row the transaction carried, with the sentence for how far it got (`revokeFailure`) and its hash once sent.
 */
export async function revokeStep(rows: readonly Approval[], deps: RevokeDeps): Promise<RowOutcome[]> {
  const { client, owner } = deps;
  const outcomes: RowOutcome[] = [];
  let pending: Approval[] = [...rows];
  let stage: RevokeStage = "signing";
  let hash: Hex | undefined;
  try {
    assertWalletOnChain(deps.walletChainId, deps.chainId);
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const toSend: Approval[] = [];
    for (const row of pending) {
      const live = readState(row, await client.readContract({ ...liveRead(owner, row), blockNumber: head }));
      if (live.cleared && nodeHasSeenApproval(head, row.lastApprovalBlock)) {
        markRevoked(owner, row, row.lastApprovalBlock);
        outcomes.push({ key: rowKey(row), result: "revoked", block: row.lastApprovalBlock });
      } else {
        toSend.push(row);
      }
    }
    pending = toSend;
    if (pending.length === 0) return outcomes;
    const { request } = await client.simulateContract({ ...revokeWrite(pending), account: deps.account });
    hash = await deps.writeContractAsync(withChain(request, deps.chainId) as never);
    stage = "sent";
    deps.onSent?.(hash);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new UserFacingError("The revoke reverted. The approval is unchanged.");
    stage = "confirmed";
    let cleared = false;
    for (const row of [...pending]) {
      const now = readState(row, await client.readContract({ ...liveRead(owner, row), blockNumber: receipt.blockNumber }));
      pending = pending.filter((r) => r !== row);
      if (now.cleared) {
        cleared = true;
        markRevoked(owner, row, Number(receipt.blockNumber));
        outcomes.push({ key: rowKey(row), result: "revoked", block: Number(receipt.blockNumber) });
      } else {
        outcomes.push({ key: rowKey(row), result: "still-set", left: now.left, hash });
      }
    }
    if (cleared) trackEvent("revoke_success");
  } catch (err) {
    const text = revokeFailure(stage, err);
    for (const row of pending) outcomes.push({ key: rowKey(row), result: "failed", text, ...(hash ? { hash } : {}) });
  }
  return outcomes;
}
