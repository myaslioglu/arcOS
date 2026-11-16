import { getAddress, isAddress } from "viem";
import type { Address, NetworkId } from "@arcos/chain";
import type { AddedWallet } from "./load";

/**
 * Wallets a person added by address: ones they came to own. Kept in the browser only, per network and per address: a
 * convenience, never the record of anything. A wallet's token isn't kept here: the factory's `tokenOf` gives it (an
 * entry saved with a `token` before that is read for its wallet alone). Every read and write is guarded, since storage
 * can be missing, full or blocked.
 */

type Store = Pick<Storage, "getItem" | "setItem">;

export const addedKey = (network: NetworkId, user: string) => `arcos.vesting.added.${network}.${user.toLowerCase()}`;

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved list; anything malformed in it is dropped, and so is a wallet saved twice. */
export function readAdded(key: string, store: Store | null = browserStore()): AddedWallet[] {
  if (!store) return [];
  try {
    const raw: unknown = JSON.parse(store.getItem(key) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const out: AddedWallet[] = [];
    for (const item of raw) {
      const { wallet } = (item ?? {}) as { wallet?: unknown };
      if (typeof wallet !== "string" || !isAddress(wallet, { strict: false })) continue;
      const w = getAddress(wallet);
      if (!out.some((a) => a.wallet === w)) out.push({ wallet: w });
    }
    return out;
  } catch {
    return [];
  }
}

/** Adds a wallet (once) and saves; returns the new list even if the save failed. */
export function addWallet(key: string, wallet: Address, store: Store | null = browserStore()): AddedWallet[] {
  const next = [...readAdded(key, store).filter((a) => a.wallet.toLowerCase() !== wallet.toLowerCase()), { wallet }];
  try {
    store?.setItem(key, JSON.stringify(next));
  } catch {
    // not saved: it still shows until the window closes
  }
  return next;
}
