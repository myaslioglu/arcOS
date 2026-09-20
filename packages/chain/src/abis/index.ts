import { keccak256, toHex } from "viem";

export { feeControllerAbi } from "./feeController";
export { tokenFactoryAbi } from "./tokenFactory";
export { multisendAbi } from "./multisend";

const key = (name: string) => keccak256(toHex(name));

/** Must match the keccak256("<NAME>") constants in the contracts. */
export const FEE_KEYS = {
  MINT_FLAT: key("MINT_FLAT"),
  DROP_PER_RECIPIENT: key("DROP_PER_RECIPIENT"),
  DROP_MIN: key("DROP_MIN"),
} as const;
