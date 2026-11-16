import { getAddress, isAddress, type Address } from "viem";
import type { NetworkId } from "@arcos/chain";

/**
 * The vaults this browser keeps for a wallet besides the factory's registry, which lists a vault only under the owner
 * it was made for: one the wallet accepted from someone else, or one opened by its address or dropped on Vault while
 * the wallet owned it or was being handed it. Kept in localStorage per network and wallet, at most MAX_REMEMBERED.
 * It is only where to look: each vault is read again, and checked with the factory's `isVault`, every time.
 */

export const MAX_REMEMBERED = 50;

const keyOf = (network: NetworkId, wallet: string) => `arcos.vault.remembered.${network}.${wallet.toLowerCase()}`;
const listeners = new Set<() => void>();
let version = 0;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The vaults remembered for `wallet`, oldest first. Anything stored that isn't an address is dropped. */
export function rememberedVaults(network: NetworkId, wallet: string, store: Storage | null = storage()): Address[] {
  let raw: string | null = null;
  try {
    raw = store?.getItem(keyOf(network, wallet)) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = list.filter((a): a is string => typeof a === "string" && isAddress(a, { strict: false })).map((a) => getAddress(a));
  return [...new Set(out)].slice(-MAX_REMEMBERED);
}

function write(network: NetworkId, wallet: string, list: readonly Address[], store: Storage | null): void {
  try {
    store?.setItem(keyOf(network, wallet), JSON.stringify(list.slice(-MAX_REMEMBERED)));
  } catch {
    // A full or blocked storage only means the vault isn't remembered: it can be opened by its address again.
  }
  version += 1;
  for (const listener of listeners) listener();
}

/** Remembers `vault` for `wallet` (once; the newest last). */
export function rememberVault(network: NetworkId, wallet: string, vault: Address, store: Storage | null = storage()): void {
  const list = rememberedVaults(network, wallet, store).filter((a) => a.toLowerCase() !== vault.toLowerCase());
  write(network, wallet, [...list, getAddress(vault)], store);
}

/** Forgets `vault` for `wallet`. */
export function forgetVault(network: NetworkId, wallet: string, vault: Address, store: Storage | null = storage()): void {
  const list = rememberedVaults(network, wallet, store);
  if (!list.some((a) => a.toLowerCase() === vault.toLowerCase())) return;
  write(network, wallet, list.filter((a) => a.toLowerCase() !== vault.toLowerCase()), store);
}

let cached: { key: string; version: number; list: readonly Address[] } | null = null;

/**
 * `rememberedVaults` for useSyncExternalStore: the same array until a list changes (or another wallet or network is
 * asked for), so a render that reads it twice sees one snapshot.
 */
export function rememberedSnapshot(network: NetworkId, wallet: string): readonly Address[] {
  const key = keyOf(network, wallet);
  if (cached && cached.key === key && cached.version === version) return cached.list;
  cached = { key, version, list: rememberedVaults(network, wallet) };
  return cached.list;
}

export function subscribeRemembered(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
