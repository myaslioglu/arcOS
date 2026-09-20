import type { Abi, PublicClient } from "viem";
import type { ChainReader } from "./types";

export function viemReader(client: PublicClient): ChainReader {
  return {
    getCode: async (address) => {
      const code = await client.getCode({ address });
      return code && code !== "0x" ? code : null;
    },
    getStorageAt: async (address, slot) => (await client.getStorageAt({ address, slot })) ?? null,
    // The function name is dynamic here, so viem's per-ABI inference can't apply; the checks cast the result.
    read: (address, abi: Abi, functionName, args = []) =>
      client.readContract({ address, abi, functionName, args } as Parameters<PublicClient["readContract"]>[0]),
    blockNumber: () => client.getBlockNumber(),
  };
}
