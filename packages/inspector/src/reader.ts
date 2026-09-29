import { BaseError, ContractFunctionZeroDataError, type Abi, type PublicClient } from "viem";
import { isRevert, revertPayload } from "./rpc-errors";
import { CallReverted, type ChainReader } from "./types";

/**
 * viem wraps a failed call deep in a `cause` chain (typically inside a `ContractFunctionExecutionError`). Two shapes
 * mean the call reached the contract and got its answer: it reverted, by the node's own account (see `isRevert`), or
 * it returned no data at all. Everything else (a timeout, an HTTP error, any JSON-RPC error that isn't a revert, a
 * gateway's -32603 included) is rethrown unchanged, because it means nothing about the contract.
 */
function mapReadError(e: unknown): never {
  if ((e instanceof BaseError && e.walk((err) => err instanceof ContractFunctionZeroDataError)) || isRevert(e)) {
    throw new CallReverted(e instanceof BaseError ? e.shortMessage : undefined, revertPayload(e));
  }
  throw e;
}

export function viemReader(client: PublicClient): ChainReader {
  return {
    getCode: async (address) => {
      const code = await client.getCode({ address });
      return code && code !== "0x" ? code : null;
    },
    getStorageAt: async (address, slot) => (await client.getStorageAt({ address, slot })) ?? null,
    // The function name is dynamic here, so viem's per-ABI inference can't apply; the checks cast the result.
    // viem's readContract hands everything it isn't typed for on to eth_call, `gas` included.
    read: (address, abi: Abi, functionName, args = [], options) =>
      client.readContract({ address, abi, functionName, args, ...(options?.gas === undefined ? {} : { gas: options.gas }) } as Parameters<PublicClient["readContract"]>[0]).catch(mapReadError),
    blockNumber: () => client.getBlockNumber(),
  };
}
