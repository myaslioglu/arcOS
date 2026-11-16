import { erc20Abi, getAddress, isAddress, pad, parseAbi, type Address, type Hex } from "viem";
import { lockVaultAbi, positionVaultAbi, vaultFactoryAbi, type PositionManagerInfo } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import type { DragItem } from "@arcos/shell";
import { shortAddress } from "@/lib/format";
import { POSITION_NFT_ABI, RECENT_BLOCKS, currencyDecimals, currencySymbols, kindOf, type GetLogs, type PositionKind } from "@/lib/positions";
import { ok, readEach, type Read } from "@/lib/reads";

/**
 * Vault's "Your locks": the vaults the factory made for the wallet, and any other vault the wallet owns or is being
 * handed. Pure, against a fake `Read` in the tests; useLocks.ts wires it to the RPC client.
 *
 * The factory registers a vault under the owner it was made for (`vaultsOf`), and only then: an ownership transfer is
 * the vault's own business (`transferOwnership` / `acceptOwnership` on the vault) and leaves the registry as it was
 * (VaultFactory.vaultsOf's own note, and test/vault/VaultRegistry.t.sol). So the list is read from three places, and
 * each vault's own `owner()` and `pendingOwner()` decide what the wallet may do with it:
 * - `vaultsOfSlice` over the wallet's registry entries, the newest LOCKS_PAGE per page asked for;
 * - vaults this browser remembers for the wallet (remembered.ts): one it accepted, opened by address or dropped;
 * - vaults whose transfer to the wallet started in the last RECENT_BLOCKS, from the RPC's OwnershipTransferStarted logs.
 * Any address from the last two must pass the factory's `isVault`, the only authoritative "is this ours" check (anyone
 * can clone the public implementations, and such a clone isn't registered).
 */

export const LOCKS_PAGE = 50;
/** A Uniswap v2 pair's views, read to name an LP token's two tokens: display only (the fee is the factory's call). */
const PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
]);
/** keccak256("OwnershipTransferStarted(address,address)"): both vaults' event, `to` second and indexed. */
export const OWNERSHIP_TRANSFER_STARTED: Hex = "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

type Base = {
  vault: Address;
  owner: Address;
  /** null when no transfer is waiting. */
  pendingOwner: Address | null;
  /** Unix seconds. */
  unlockAt: number;
};
export type TokenLock = Base & {
  kind: "token";
  token: Address;
  symbol: string;
  decimals: number | null;
  /** The vault's live balance of the token (`lockedAmount()`), null when it couldn't be read. */
  amount: bigint | null;
  /** For a Uniswap v2 LP token: the pair's two tokens, the ones whose liquidity the lock holds. */
  pair: { token0: Address; token1: Address; symbol0: string; symbol1: string } | null;
};
export type PositionLock = Base & {
  kind: "position";
  manager: Address;
  managerName: string;
  positionKind: PositionKind | null;
  tokenId: string;
  /** ArcOS's share of collected fees, fixed in the vault when it was made. */
  feeShareBps: number | null;
  currency0: Address | null;
  currency1: Address | null;
  symbol0: string;
  symbol1: string;
  /** Each currency's decimals, for what a collect paid; null where unknown. */
  decimals0: number | null;
  decimals1: number | null;
  liquidity: bigint | null;
  /** The position has left the vault (`withdraw` sent it to the owner): its manager names another owner for it. */
  withdrawn: boolean;
};
export type Lock = TokenLock | PositionLock;

/** What the wallet is to a vault: its owner, the owner it is being handed to, or neither (it was handed on). */
export type Role = "owner" | "incoming" | "other";

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const asAddress = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null);

export function roleOf(lock: Pick<Lock, "owner" | "pendingOwner">, wallet: string): Role {
  if (same(lock.owner, wallet)) return "owner";
  if (same(lock.pendingOwner, wallet)) return "incoming";
  return "other";
}

/** Whether `withdraw` would pass its time check now: `block.timestamp >= unlockAt`. */
export function isUnlocked(lock: Pick<Lock, "unlockAt">, now: number): boolean {
  return now >= lock.unlockAt;
}

/** The file a lock is, for a drag: it names the vault, which the window it lands on reads on chain. */
export function lockDragItem(lock: Pick<Lock, "vault">): DragItem {
  return { kind: "lock", address: lock.vault };
}

/** "1,000 VTA", "Uniswap v4 #328647": what a lock holds, in a few words. */
export function lockTitle(lock: Lock, amountText: (units: bigint, decimals: number) => string): string {
  if (lock.kind === "position") return `${lock.managerName} #${lock.tokenId}`;
  if (lock.amount === null || lock.decimals === null) return lock.symbol;
  return `${amountText(lock.amount, lock.decimals)} ${lock.symbol}`;
}

/**
 * The tokens a lock's proof pages (/t/<token>) are about: the locked token, or for liquidity the tokens it is liquidity
 * of: an LP token's pair, or a position's two currencies (native USDC has no page).
 */
export function proofTokens(lock: Lock): Address[] {
  if (lock.kind === "token") return lock.pair ? [lock.pair.token0, lock.pair.token1] : [lock.token];
  return [lock.currency0, lock.currency1].filter((c): c is Address => c !== null && c !== ZERO);
}

/**
 * Whether a vault holds nothing any more: a token vault whose balance is zero (all withdrawn; `withdraw` can run again
 * for tokens that arrive later), or a position vault whose position was withdrawn.
 */
export function isEmpty(lock: Lock): boolean {
  return lock.kind === "token" ? lock.amount === 0n : lock.withdrawn;
}

export type Group = Role | "empty";

/**
 * The groups the list shows, in order: transfers waiting for the wallet, the wallet's locks, its emptied vaults, and
 * the rest (handed over, or never the wallet's).
 */
export function groupLocks(locks: readonly Lock[], wallet: string): Record<Group, Lock[]> {
  const out: Record<Group, Lock[]> = { incoming: [], owner: [], empty: [], other: [] };
  for (const lock of locks) {
    const role = roleOf(lock, wallet);
    out[role === "owner" && isEmpty(lock) ? "empty" : role].push(lock);
  }
  return out;
}

export type LocksDeps = {
  read: Read;
  factory: Address;
  wallet: Address;
  /** Vaults to read besides the registry's: remembered or opened ones. */
  extra: readonly Address[];
  /** How many registry pages (LOCKS_PAGE each, newest first) to read. */
  pages: number;
  /** Known managers, for a position's name. */
  managers: readonly PositionManagerInfo[];
  /** The RPC's logs, for transfers to the wallet that started recently; left out, none are looked for. */
  getLogs?: GetLogs;
  getBlockNumber?: () => Promise<bigint>;
};

export type LocksAnswer = {
  locks: Lock[];
  /** How many vaults the factory registered for the wallet in all. */
  registered: number;
  /** How many of them this answer read. */
  readFromRegistry: number;
  /** Addresses from `extra` that the factory says are not its vaults. */
  notVaults: Address[];
};

/** The vaults whose transfer to `wallet` started over the last RECENT_BLOCKS (any contract's event: `isVault` decides). */
export async function recentIncoming(getLogs: GetLogs, latest: bigint, wallet: Address): Promise<Address[]> {
  const fromBlock = latest > RECENT_BLOCKS ? latest - RECENT_BLOCKS : 0n;
  const logs = (await getLogs({
    // No address: every vault's event (and anything else's with the same signature; isVault sorts them out).
    topics: [OWNERSHIP_TRANSFER_STARTED, null, pad(wallet.toLowerCase() as Hex, { size: 32 })],
    fromBlock,
    toBlock: latest,
  })) as readonly { address?: string; topics: readonly (Hex | null)[] }[];
  return [...new Set(logs.flatMap((l) => (asAddress(l.address) ? [asAddress(l.address)!] : [])))];
}

const baseOf = (h: Base): Base => ({ vault: h.vault, owner: h.owner, pendingOwner: h.pendingOwner, unlockAt: h.unlockAt });

const managerName = (managers: readonly PositionManagerInfo[], manager: Address) =>
  managers.find((m) => same(m.address, manager))?.name ?? `Manager ${shortAddress(manager)}`;

/** Every lock to show the wallet. Throws only when the factory or the vaults' own state can't be read. */
export async function loadLocks(deps: LocksDeps): Promise<LocksAnswer> {
  const { read, factory, wallet } = deps;
  const [countResult] = await read([{ address: factory, abi: vaultFactoryAbi, functionName: "vaultsOfLength", args: [wallet] }]);
  const registered = ok(countResult);
  if (typeof registered !== "bigint") throw new Error("Couldn't read the factory's registry.");
  const want = BigInt(Math.max(1, deps.pages) * LOCKS_PAGE);
  const start = registered > want ? registered - want : 0n;
  let fromRegistry: Address[] = [];
  if (registered > 0n) {
    const [slice] = await read([{ address: factory, abi: vaultFactoryAbi, functionName: "vaultsOfSlice", args: [wallet, start, registered - start] }]);
    const list = ok(slice);
    if (!Array.isArray(list)) throw new Error("Couldn't read the factory's registry.");
    fromRegistry = list.flatMap((a) => (asAddress(a) ? [asAddress(a)!] : [])).reverse();
  }

  let extra = [...deps.extra];
  if (deps.getLogs && deps.getBlockNumber) {
    try {
      extra = [...extra, ...(await recentIncoming(deps.getLogs, await deps.getBlockNumber(), wallet))];
    } catch {
      // The recent transfers are a convenience: the registry and the remembered vaults still answer.
    }
  }
  const known = new Set(fromRegistry.map((a) => a.toLowerCase()));
  const extras = [...new Set(extra.map((a) => getAddress(a)))].filter((a) => !known.has(a.toLowerCase()));
  const checks = extras.length
    ? await read(extras.map((a) => ({ address: factory, abi: vaultFactoryAbi, functionName: "isVault", args: [a] })))
    : [];
  const verified = extras.filter((_, i) => ok(checks[i]) === true);
  const notVaults = extras.filter((_, i) => checks[i]?.status === "success" && ok(checks[i]) === false);
  const vaults = [...fromRegistry, ...verified];

  // The vault's own state. `token()` answers on a LockVault only and `manager()` on a PositionVault only, so each
  // vault tells which it is by which of the two it answers.
  const state = vaults.length
    ? await read(
        vaults.flatMap((v) => [
          { address: v, abi: lockVaultAbi, functionName: "owner" },
          { address: v, abi: lockVaultAbi, functionName: "pendingOwner" },
          { address: v, abi: lockVaultAbi, functionName: "unlockAt" },
          { address: v, abi: lockVaultAbi, functionName: "token" },
          { address: v, abi: positionVaultAbi, functionName: "manager" },
        ]),
      )
    : [];
  type Head = Base & { token: Address | null; manager: Address | null };
  const heads: Head[] = vaults.flatMap((vault, i) => {
    const owner = asAddress(ok(state[i * 5]));
    const pending = asAddress(ok(state[i * 5 + 1]));
    const unlockAt = ok(state[i * 5 + 2]);
    const token = asAddress(ok(state[i * 5 + 3]));
    const manager = asAddress(ok(state[i * 5 + 4]));
    if (!owner || typeof unlockAt !== "bigint" || (!token && !manager)) return [];
    return [{ vault, owner, pendingOwner: pending && pending !== ZERO ? pending : null, unlockAt: Number(unlockAt), token, manager }];
  });

  const tokenHeads = heads.filter((h) => h.token);
  const positionHeads = heads.filter((h) => !h.token && h.manager);
  // A locked token is anyone's contract: its reads stand alone (readEach), so one that burns its gas can't hide the rest.
  const PER_TOKEN = 6;
  const tokenReads = await readEach(
    read,
    tokenHeads.flatMap((h) => [
      { address: h.token!, abi: erc20Abi, functionName: "symbol" },
      { address: h.token!, abi: erc20Abi, functionName: "decimals" },
      { address: h.vault, abi: lockVaultAbi, functionName: "lockedAmount" },
      { address: h.token!, abi: PAIR_ABI, functionName: "token0" },
      { address: h.token!, abi: PAIR_ABI, functionName: "token1" },
      { address: h.token!, abi: PAIR_ABI, functionName: "getReserves" },
    ]),
  );
  // An LP token answers all three pair views; its two tokens are named like a position's currencies.
  const pairOf = (i: number): [Address, Address] | null => {
    const [t0, t1] = [asAddress(ok(tokenReads[i * PER_TOKEN + 3])), asAddress(ok(tokenReads[i * PER_TOKEN + 4]))];
    return t0 && t1 && Array.isArray(ok(tokenReads[i * PER_TOKEN + 5])) ? [t0, t1] : null;
  };
  const pairSymbols = await currencySymbols(read, tokenHeads.flatMap((_, i) => pairOf(i) ?? []));
  // A position vault's reads go to the vault and to its manager, which the factory had allowed when it made the vault.
  const positionReads = positionHeads.length
    ? await read(
        positionHeads.flatMap((h) => [
          { address: h.vault, abi: positionVaultAbi, functionName: "tokenId" },
          { address: h.vault, abi: positionVaultAbi, functionName: "kind" },
          { address: h.vault, abi: positionVaultAbi, functionName: "feeShareBps" },
          { address: h.vault, abi: positionVaultAbi, functionName: "currencies" },
          { address: h.vault, abi: positionVaultAbi, functionName: "liquidity" },
        ]),
      )
    : [];
  // Who holds each position now: the vault until `withdraw`, the owner after it.
  const holders = positionHeads.length
    ? await read(
        positionHeads.map((h, i) => {
          const id = ok(positionReads[i * 5]);
          return { address: h.manager!, abi: POSITION_NFT_ABI, functionName: "ownerOf", args: [typeof id === "bigint" ? id : 0n] };
        }),
      )
    : [];
  const pairs = positionHeads.map((_, i) => {
    const c = ok(positionReads[i * 5 + 3]);
    return Array.isArray(c) ? [asAddress(c[0]), asAddress(c[1])] : [null, null];
  });
  const currencies = pairs.flat().filter((c): c is Address => c !== null);
  const [symbols, decimals] = await Promise.all([currencySymbols(read, currencies), currencyDecimals(read, currencies)]);

  const byVault = new Map<string, Lock>();
  tokenHeads.forEach((h, i) => {
    const symbol = ok(tokenReads[i * PER_TOKEN]);
    const decimals = ok(tokenReads[i * PER_TOKEN + 1]);
    const amount = ok(tokenReads[i * PER_TOKEN + 2]);
    const pair = pairOf(i);
    const token = h.token!;
    byVault.set(h.vault.toLowerCase(), {
      ...baseOf(h),
      kind: "token",
      token,
      symbol: cleanLabel(typeof symbol === "string" ? symbol : null, 32) ?? shortAddress(token),
      decimals: typeof decimals === "number" && decimals >= 0 && decimals <= 255 ? decimals : null,
      amount: typeof amount === "bigint" ? amount : null,
      pair: pair
        ? {
            token0: pair[0],
            token1: pair[1],
            symbol0: pairSymbols.get(pair[0].toLowerCase()) ?? "?",
            symbol1: pairSymbols.get(pair[1].toLowerCase()) ?? "?",
          }
        : null,
    });
  });
  positionHeads.forEach((h, i) => {
    const tokenId = ok(positionReads[i * 5]);
    const kind = ok(positionReads[i * 5 + 1]);
    const share = ok(positionReads[i * 5 + 2]);
    const liquidity = ok(positionReads[i * 5 + 4]);
    const [currency0, currency1] = pairs[i] as [Address | null, Address | null];
    const manager = h.manager!;
    byVault.set(h.vault.toLowerCase(), {
      ...baseOf(h),
      kind: "position",
      manager,
      managerName: managerName(deps.managers, manager),
      positionKind: kindOf(kind),
      tokenId: typeof tokenId === "bigint" ? tokenId.toString() : "?",
      feeShareBps: typeof share === "number" ? share : null,
      currency0,
      currency1,
      symbol0: currency0 ? (symbols.get(currency0.toLowerCase()) ?? "?") : "?",
      symbol1: currency1 ? (symbols.get(currency1.toLowerCase()) ?? "?") : "?",
      decimals0: currency0 ? (decimals.get(currency0.toLowerCase()) ?? null) : null,
      decimals1: currency1 ? (decimals.get(currency1.toLowerCase()) ?? null) : null,
      liquidity: typeof liquidity === "bigint" ? liquidity : null,
      withdrawn: (() => {
        const holder = asAddress(ok(holders[i]));
        return holder !== null && !same(holder, h.vault);
      })(),
    });
  });
  const locks = vaults.flatMap((v) => byVault.get(v.toLowerCase()) ?? []);
  return { locks, registered: Number(registered), readFromRegistry: fromRegistry.length, notVaults };
}
