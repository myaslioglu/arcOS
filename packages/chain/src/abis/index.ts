import { keccak256, toHex } from "viem";

export { feeControllerAbi } from "./feeController";
export { tokenFactoryAbi } from "./tokenFactory";
export { multisendAbi } from "./multisend";
export { lockVaultAbi } from "./lockVault";
export { vaultFactoryAbi } from "./vaultFactory";
export { positionVaultAbi } from "./positionVault";
export { arcVestingAbi } from "./arcVesting";
export { vestingFactoryAbi } from "./vestingFactory";
export { proPassAbi } from "./proPass";

const key = (name: string) => keccak256(toHex(name));

/**
 * Must match the keccak256("<NAME>") constants in the contracts. Flat fees are native USDC at 18 decimals; _BPS keys
 * are basis points.
 */
export const FEE_KEYS = {
  // R0: TokenFactory, Multisend
  MINT_FLAT: key("MINT_FLAT"),
  DROP_PER_RECIPIENT: key("DROP_PER_RECIPIENT"),
  DROP_MIN: key("DROP_MIN"),
  // R1: VaultFactory
  LOCK_FLAT: key("LOCK_FLAT"),
  LOCK_LP_BPS: key("LOCK_LP_BPS"),
  LOCK_FEE_SHARE_BPS: key("LOCK_FEE_SHARE_BPS"),
  // R1: VestingFactory
  VEST_FLAT: key("VEST_FLAT"),
  // R1: ProPass
  PRO_MONTHLY: key("PRO_MONTHLY"),
} as const;
