import { getAddress, isAddress, type Address } from "viem";
import type { DragItem } from "@arcos/shell";

/**
 * What a drop on Vault, or the params it opens with (a drop on its icon, a deep link, another app's button), ask it to
 * show: a token or a position in the New lock form, or a vault in Your locks. Each names the thing only; the window
 * reads it on chain before it offers anything.
 */
export type Target =
  | { kind: "token"; token: Address }
  | { kind: "position"; manager: Address; tokenId: string }
  | { kind: "vault"; vault: Address };

/** A uint256 in decimal. */
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = 2n ** 256n - 1n;
const address = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null);
const tokenId = (v: unknown): string | null => (typeof v === "string" && UINT.test(v) && BigInt(v) <= MAX_UINT256 ? v : null);

/** The window's params as a target: `vault`, else `manager` and `tokenId`, else `token`. Null for none or junk. */
export function targetFromParams(params: Readonly<Record<string, string>>): Target | null {
  const vault = address(params.vault);
  if (vault) return { kind: "vault", vault };
  const manager = address(params.manager);
  const id = tokenId(params.tokenId);
  if (manager && id !== null) return { kind: "position", manager, tokenId: id };
  const token = address(params.token);
  return token ? { kind: "token", token } : null;
}

/** A dropped file as a target. An approval names a token too, but Vault doesn't take one. */
export function targetFromDrop(item: DragItem): Target | null {
  switch (item.kind) {
    case "token": {
      const token = address(item.address);
      return token ? { kind: "token", token } : null;
    }
    case "lp-position": {
      const manager = address(item.manager);
      const id = tokenId(item.tokenId);
      return manager && id !== null ? { kind: "position", manager, tokenId: id } : null;
    }
    case "lock": {
      const vault = address(item.address);
      return vault ? { kind: "vault", vault } : null;
    }
    default:
      return null;
  }
}
