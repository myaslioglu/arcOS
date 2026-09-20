import type { PublicClient } from "viem";
import { DEX, KNOWN_LOCKERS, activeChain, activeNetwork, type Address } from "@arcos/chain";
import { blockscoutSource, viemReader, type InspectInput } from "@arcos/inspector";

export function inspectInput(address: Address, client: PublicClient, fetchFn: typeof fetch = fetch): InspectInput {
  const network = activeNetwork();
  const explorer = activeChain().blockExplorers?.default;
  return {
    address,
    network,
    reader: viemReader(client),
    explorer: explorer?.apiUrl ? blockscoutSource(explorer.apiUrl, fetchFn) : null,
    dex: DEX[network],
    knownLockers: KNOWN_LOCKERS[network],
    explorerBase: explorer?.url ?? "",
  };
}
