import { ARCOS, activeNetwork, type Address, type NetworkId } from "@arcos/chain";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

/**
 * The network's VaultFactory, or null where none is set. Read the way the app registry reads it to decide whether
 * Vault is live there (`contractAddress` in apps/registry.ts): anything but a non-zero 20-byte hex address reads as not
 * set. Finder's Positions section and Vault itself use it; neither shows anything where it is null.
 */
export function vaultFactoryOf(network: NetworkId = activeNetwork(), contracts: object | null | undefined = ARCOS[network]): Address | null {
  const value: unknown = contracts ? (contracts as Record<string, unknown>).vaultFactory : undefined;
  return typeof value === "string" && ADDRESS.test(value) && !ZERO.test(value) ? (value as Address) : null;
}
