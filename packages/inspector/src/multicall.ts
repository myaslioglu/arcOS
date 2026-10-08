import { decodeFunctionResult, encodeFunctionData, multicall3Abi, type Abi } from "viem";
import { MULTICALL3, type Address } from "@arcos/chain";
import type { Hex } from "./bytecode";
import type { ChainReader } from "./types";

/** One question in a batch, in viem's terms. */
export type BatchCall = { target: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/**
 * One call's own outcome. `ok: false` covers a revert and an answer its ABI can't decode. The second is what a call to an
 * address with no code returns: Multicall3 reports that as a success carrying `0x`, so "the call succeeded" alone never
 * means "the contract is there".
 */
export type BatchResult = { ok: true; value: unknown } | { ok: false };

/** Where the batch is read: `blockNumber` pins every call in it to that block; without it, the latest. */
export type MulticallOptions = { blockNumber?: bigint };

/**
 * `aggregate3` over `calls`, each allowed to fail on its own: one request however many calls. Rejects as any read does
 * (`CallReverted` when the aggregate itself reverts, the transport's error otherwise); a call that failed inside it never
 * rejects, it comes back `ok: false`. `options` go to the reader as they are, so a batch can be pinned to a block.
 */
export async function multicall(reader: ChainReader, calls: readonly BatchCall[], options?: MulticallOptions): Promise<BatchResult[]> {
  if (calls.length === 0) return [];
  const call3 = calls.map((c) => ({
    target: c.target,
    allowFailure: true,
    // The function name is dynamic here, so viem's per-ABI inference can't apply (see reader.ts).
    callData: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as Parameters<typeof encodeFunctionData>[0]),
  }));
  const answers = (await reader.read(MULTICALL3, multicall3Abi, "aggregate3", [call3], options?.blockNumber === undefined ? undefined : { blockNumber: options.blockNumber })) as readonly {
    success: boolean;
    returnData: Hex;
  }[];
  if (answers.length !== calls.length) throw new Error(`Multicall3 answered ${answers.length} of ${calls.length} calls`);
  return calls.map((c, i): BatchResult => {
    const answer = answers[i]!;
    if (!answer.success) return { ok: false };
    try {
      return { ok: true, value: decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data: answer.returnData } as Parameters<typeof decodeFunctionResult>[0]) };
    } catch {
      return { ok: false };
    }
  });
}
