import { erc20Abi, parseAbi, type Abi, type Address } from "viem";
import { PERMIT2 } from "@arcos/chain";
import { NFT_ABI, PERMIT2_ABI, type Approval } from "@/lib/approvals";
import { APPROVE_ABI } from "./rows";

/**
 * What each kind of approval is revoked with, and read back with. Pure: the flow (flow.ts) sends and reads these.
 * - ERC-20: `approve(spender, 0)`; read `allowance(owner, spender)`.
 * - One NFT: `approve(0x0, id)`, the same selector as ERC-20's approve; read `getApproved(id)`.
 * - Operator: `setApprovalForAll(operator, false)`; read `isApprovedForAll(owner, operator)`.
 * - Permit2: `lockdown([(token, spender), …])` on Permit2, which sets each named allowance to zero in one
 *   transaction; read Permit2's `allowance(owner, token, spender)`.
 */

const SET_APPROVAL_FOR_ALL_ABI = parseAbi(["function setApprovalForAll(address operator, bool approved)"]);
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export type ContractCall = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };

/**
 * An NFT row's id. One without a decimal id throws: `BigInt("")` is 0n, and a transaction must never approve the
 * zero address for NFT #0 in place of the NFT the row names. (The answer parser already refuses such a row.)
 */
function nftId(row: Approval): bigint {
  if (typeof row.tokenId !== "string" || !/^\d+$/.test(row.tokenId)) throw new Error("This NFT approval has no id.");
  return BigInt(row.tokenId);
}

/** The one transaction that revokes `rows`: a single row of any kind, or any number of Permit2 pairs together. */
export function revokeWrite(rows: readonly Approval[]): ContractCall {
  const [first] = rows;
  if (!first) throw new Error("Nothing to revoke.");
  if (rows.length > 1 && !rows.every((r) => r.kind === "permit2")) throw new Error("Only Permit2 pairs share a transaction.");
  switch (first.kind) {
    case "erc20":
      return { address: first.token, abi: APPROVE_ABI, functionName: "approve", args: [first.spender, 0n] };
    case "erc721":
      return { address: first.token, abi: APPROVE_ABI, functionName: "approve", args: [ZERO_ADDRESS, nftId(first)] };
    case "operator":
      return { address: first.token, abi: SET_APPROVAL_FOR_ALL_ABI, functionName: "setApprovalForAll", args: [first.spender, false] };
    case "permit2":
      return {
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: "lockdown",
        args: [rows.map((r) => ({ token: r.token, spender: r.spender }))],
      };
  }
}

/** The read that says whether `row` is still set. */
export function liveRead(owner: Address, row: Approval): ContractCall {
  switch (row.kind) {
    case "erc20":
      return { address: row.token, abi: erc20Abi, functionName: "allowance", args: [owner, row.spender] };
    case "erc721":
      return { address: row.token, abi: NFT_ABI, functionName: "getApproved", args: [nftId(row)] };
    case "operator":
      return { address: row.token, abi: NFT_ABI, functionName: "isApprovedForAll", args: [owner, row.spender] };
    case "permit2":
      return { address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, row.token, row.spender] };
  }
}

/**
 * What `liveRead`'s answer says: cleared, or still set with what is left (an amount, or "1" for an NFT or operator).
 * An answer of a shape the read can't give counts as still set, so nothing is hidden on a misread.
 */
export function readState(row: Approval, answer: unknown): { cleared: boolean; left: string } {
  switch (row.kind) {
    case "erc20":
      return typeof answer === "bigint" ? { cleared: answer === 0n, left: answer.toString() } : { cleared: false, left: row.allowance };
    case "erc721":
      return { cleared: typeof answer === "string" && answer.toLowerCase() === ZERO_ADDRESS, left: "1" };
    case "operator":
      return { cleared: answer === false, left: "1" };
    case "permit2": {
      const amount = Array.isArray(answer) ? (answer as unknown[])[0] : undefined;
      return typeof amount === "bigint" ? { cleared: amount === 0n, left: amount.toString() } : { cleared: false, left: row.allowance };
    }
  }
}

/**
 * A bulk revoke's transactions, in order: each row of its own, in the order listed, then every Permit2 pair in one
 * `lockdown`, last.
 */
export function revokeSteps(rows: readonly Approval[]): Approval[][] {
  const single = rows.filter((r) => r.kind !== "permit2").map((r) => [r]);
  const permit2 = rows.filter((r) => r.kind === "permit2");
  return permit2.length > 0 ? [...single, permit2] : single;
}
