import { numberToHex, type Abi, type Address, type Hex, type PublicClient } from "viem";

/**
 * Contract reads batched through Multicall3, in the shape viem's `multicall({ contracts, allowFailure: true })` answers:
 * one result per call, each a success or a failure of its own. Pure types and helpers, so the modules that read
 * through them (positions.ts, Vault's locks) can be tested against a fake `Read`.
 */
export type ContractRead = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
export type ReadResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
/** One batch of reads. It throws only when the batch itself can't be answered (the RPC is down, or a call in it used
 * up the whole call's gas). */
export type Read = (calls: readonly ContractRead[]) => Promise<ReadResult[]>;

/** The result of a call that succeeded, else undefined. */
export function ok(result: ReadResult | undefined): unknown {
  return result?.status === "success" ? result.result : undefined;
}

/** At most this many batches per `readEach` call, the first included. */
export const READ_BUDGET = 16;

const failed = (error: unknown): ReadResult => ({ status: "failure", error });

/**
 * Reads `calls` so that no single call can take the others down with it. A batch answers every call, failures
 * included, as long as the batch itself completes; but a call into a contract that burns all the gas it is given fails
 * the whole `eth_call`, and a token anyone can deploy (a locked token, a pool's currency) can be such a contract. A
 * batch that throws is split in two and each half read again, breadth-first, until each failing call stands alone or
 * `budget` batches have been sent; whatever is left then counts as failed. A clean read is one batch.
 *
 * Only for reads whose failure the caller can show as "unknown" (a symbol, a balance): an RPC that is down fails every
 * batch the same way, and comes back as every call failed rather than as an error.
 */
export async function readEach(read: Read, calls: readonly ContractRead[], budget: number = READ_BUDGET): Promise<ReadResult[]> {
  const out: ReadResult[] = new Array<ReadResult>(calls.length);
  if (calls.length === 0) return out;
  let queue: Array<[number, number]> = [[0, calls.length]];
  let sent = 0;
  while (queue.length > 0) {
    const next: Array<[number, number]> = [];
    for (const [from, to] of queue) {
      if (sent >= budget) {
        for (let i = from; i < to; i++) out[i] = failed(new Error("read budget spent"));
        continue;
      }
      sent += 1;
      try {
        const results = await read(calls.slice(from, to));
        for (let i = from; i < to; i++) out[i] = results[i - from] ?? failed(new Error("no result"));
      } catch (error) {
        if (to - from === 1) out[from] = failed(error);
        else {
          const mid = from + Math.ceil((to - from) / 2);
          next.push([from, mid], [mid, to]);
        }
      }
    }
    queue = next;
  }
  return out;
}

/** eth_getLogs with raw topics; no `address` asks every contract. */
export type GetLogs = (args: { address?: Address; topics: (Hex | null)[]; fromBlock: bigint; toBlock: bigint }) => Promise<
  readonly { address?: string; topics: readonly (Hex | null)[] }[]
>;

/**
 * The reads above on viem's public client: `read` through Multicall3 (the chain's own, which viem finds in the chain
 * definition), `getLogs` as eth_getLogs itself (viem's getLogs builds its topics from an event; these are given raw),
 * and the latest block number, never a cached one.
 */
export function clientReads(client: PublicClient): { read: Read; getLogs: GetLogs; getBlockNumber: () => Promise<bigint> } {
  return {
    read: ((calls) => client.multicall({ contracts: calls as never, allowFailure: true })) as Read,
    getLogs: (({ address, topics, fromBlock, toBlock }) =>
      client.request({
        method: "eth_getLogs",
        params: [{ ...(address ? { address } : {}), topics, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }],
      })) as GetLogs,
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
  };
}
