import { getAddress, isAddress } from "viem";
import type { Address, NetworkId } from "@arcos/chain";
import type { AddedWallet } from "./load";
import type { TokenCache } from "./tokenSource";

/**
 * Wallets a person added by address (ones they came to own, or whose token the event lookup couldn't find). Kept in the
 * browser only, per network and per address: a convenience, never the record of anything. Every read and write is
 * guarded, since storage can be missing, full or blocked.
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

/** The saved list; anything malformed in it is dropped. */
export function readAdded(key: string, store: Store | null = browserStore()): AddedWallet[] {
  if (!store) return [];
  try {
    const raw: unknown = JSON.parse(store.getItem(key) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const out: AddedWallet[] = [];
    for (const item of raw) {
      const { wallet, token } = (item ?? {}) as { wallet?: unknown; token?: unknown };
      if (typeof wallet === "string" && typeof token === "string" && isAddress(wallet, { strict: false }) && isAddress(token, { strict: false })) {
        out.push({ wallet: getAddress(wallet), token: getAddress(token) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Adds or replaces (by wallet) and saves; returns the new list even if the save failed. */
export function addWallet(key: string, wallet: Address, token: Address, store: Store | null = browserStore()): AddedWallet[] {
  const next = [...readAdded(key, store).filter((a) => a.wallet.toLowerCase() !== wallet.toLowerCase()), { wallet, token }];
  try {
    store?.setItem(key, JSON.stringify(next));
  } catch {
    // not saved: it still shows until the window closes
  }
  return next;
}

/** Which token each wallet was made for, kept in the browser per network: found once, it never changes. */
export function tokenCache(network: NetworkId, store: Store | null = browserStore()): TokenCache {
  const key = `arcos.vesting.tokens.${network}`;
  const read = (): Record<string, string> => {
    try {
      const raw: unknown = JSON.parse(store?.getItem(key) ?? "{}");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (wallet) => {
      const t = read()[wallet.toLowerCase()];
      return typeof t === "string" && isAddress(t, { strict: false }) ? getAddress(t) : undefined;
    },
    set: (wallet, token) => {
      try {
        store?.setItem(key, JSON.stringify({ ...read(), [wallet.toLowerCase()]: token }));
      } catch {
        // not saved: it is looked up again next time
      }
    },
  };
}
