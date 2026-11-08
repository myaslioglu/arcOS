import type { InspectChain } from "@arcos/chain";
import type { InspectInput } from "./types";

/** The `InspectInput` fields that describe the chain: what an inspection of a token on it needs to know about it. */
export type ChainInput = Pick<
  InspectInput,
  "chain" | "dex" | "knownLockers" | "explorerBase" | "arcosTokenFactory" | "nativeQuote" | "tradeQuote" | "lockersVetted" | "unscanned" | "prevrandao"
>;

/** `chain`'s registry entry (`INSPECT_CHAINS` in @arcos/chain) as `InspectInput` fields. Evidence links go to its Blockscout UI. */
export function chainInput(chain: InspectChain): ChainInput {
  return {
    chain: { key: chain.key, name: chain.name, chainId: chain.chainId },
    dex: chain.dex,
    knownLockers: chain.knownLockers,
    explorerBase: chain.explorer.url,
    arcosTokenFactory: chain.arcosTokenFactory,
    nativeQuote: chain.nativeQuote,
    tradeQuote: chain.tradeQuote,
    lockersVetted: chain.lockersVetted,
    unscanned: chain.unscanned,
    prevrandao: chain.prevrandao,
  };
}
