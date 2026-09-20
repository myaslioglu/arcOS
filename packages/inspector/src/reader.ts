import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, type Abi, type PublicClient } from "viem";
import { CallReverted, type ChainReader } from "./types";

/**
 * viem wraps a revert deep in a `cause` chain (typically inside a `ContractFunctionExecutionError`).
 * Walk it looking for the two shapes that mean "the call reached the chain and reverted, or
 * returned no data" — everything else (timeouts, 5xx, bad JSON) is a transport failure and is
 * rethrown unchanged, because it means nothing about the contract.
 */
function mapReadError(e: unknown): never {
  if (e instanceof BaseError) {
    const cause = e.walk((err) => err instanceof ContractFunctionRevertedError || err instanceof ContractFunctionZeroDataError);
    if (cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError) {
      throw new CallReverted(cause.shortMessage);
    }
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
    read: (address, abi: Abi, functionName, args = []) =>
      client.readContract({ address, abi, functionName, args } as Parameters<PublicClient["readContract"]>[0]).catch(mapReadError),
    blockNumber: () => client.getBlockNumber(),
  };
}
