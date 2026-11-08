import { arcInspectChain, type NetworkId } from "@arcos/chain";
import { chainInput, type ChainInput } from "../../chain-input";

/**
 * Arc's chain fields for an `InspectInput` a test builds by hand (see `chainInput`): all of them but the DEX config, the
 * lockers, the explorer base and the TokenFactory, which each test sets for itself.
 */
export function arcFields(network: NetworkId = "mainnet"): Pick<ChainInput, "chain" | "nativeQuote" | "tradeQuote" | "lockersVetted" | "unscanned" | "prevrandao"> {
  const { chain, nativeQuote, tradeQuote, lockersVetted, unscanned, prevrandao } = chainInput(arcInspectChain(network));
  return { chain, nativeQuote, tradeQuote, lockersVetted, unscanned, prevrandao };
}
