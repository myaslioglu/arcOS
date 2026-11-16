import { getAddress, isAddress, pad, parseAbi, type Address, type Hex } from "viem";
import { vaultFactoryAbi, type PositionManagerInfo } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import { shortAddress } from "./format";
import { ok, readEach, type GetLogs, type Read } from "./reads";

export type { GetLogs };

/**
 * A wallet's liquidity positions (Uniswap v3 and v4 position NFTs) in the managers the VaultFactory allows: what
 * Finder's Positions section lists and Vault locks. Pure, so every rule is tested against fake reads; usePositions.ts
 * wires it to the RPC client and the explorer.
 *
 * Where the ids come from, per manager:
 * - an ERC721Enumerable manager (Uniswap v3's, checked on chain with `supportsInterface(0x780e9d63)`) lists them
 *   itself: `balanceOf` and `tokenOfOwnerByIndex`. That is the whole list.
 * - any other (Uniswap v4's PositionManager is not enumerable) has no such view, so the ids come from the explorer's
 *   list of that collection's tokens the wallet holds (Blockscout's `/tokens/<manager>/instances?holder_address_hash=`),
 *   and from the RPC's Transfer logs to the wallet over the last RECENT_BLOCKS, for a position the explorer hasn't
 *   indexed yet. Each id is then checked with `ownerOf`, so neither source is trusted for who holds it. When the
 *   explorer doesn't answer, the list holds the recent ones only and says so; any position can still be typed into
 *   Vault by its id.
 */

/** ERC-165 id of ERC721Enumerable. */
export const ERC721_ENUMERABLE: Hex = "0x780e9d63";
/** At most this many positions are listed per manager. */
export const MAX_POSITIONS = 100;
/** The explorer is asked for at most this many pages (it answers 50 tokens a page). */
export const EXPLORER_PAGES = 2;
/**
 * The RPC's Transfer logs are read over this many blocks back from the latest: about 17 minutes on mainnet at Arc's
 * half-second blocks. One request: rpc.mainnet.arc.io answered a 5,000-block range and refused 10,000 ("requested
 * range too large") on 2026-11-16.
 */
export const RECENT_BLOCKS = 2_000n;
/** keccak256("Transfer(address,address,uint256)"), ERC-721's (and ERC-20's) Transfer event. */
export const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** v4's flag for a pool whose fee its hook sets (LPFeeLibrary.DYNAMIC_FEE_FLAG). */
const DYNAMIC_FEE = 0x800000;
/** A uint256 in decimal, as the explorer writes a token id. */
const UINT = /^(0|[1-9][0-9]{0,77})$/;

export const POSITION_NFT_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
]);
/** Uniswap v3's NonfungiblePositionManager: what a position holds. It reverts ("Invalid token ID") for an id it never minted. */
export const V3_POSITIONS_ABI = parseAbi([
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
/** Uniswap v4's PositionManager: a position's pool and liquidity. An id it never minted answers an all-zero pool. */
export const V4_POSITIONS_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
]);
const SYMBOL_ABI = parseAbi(["function symbol() view returns (string)"]);
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

/** PositionVault.Kind: 0 is Uniswap v3's manager, 1 is v4's. */
export type PositionKind = "v3" | "v4";
export type AllowedManager = PositionManagerInfo & { kind: PositionKind };

export type Position = {
  manager: Address;
  managerName: string;
  kind: PositionKind;
  /** Decimal. */
  tokenId: string;
  currency0: Address;
  currency1: Address;
  symbol0: string;
  symbol1: string;
  /** The pool's fee in hundredths of a basis point (3000 is 0.3%), or v4's dynamic-fee flag. */
  fee: number;
  liquidity: bigint;
  /** v3 only: tokens are waiting in `tokensOwed`, which the factory refuses (OwedNotCollected). */
  owed: boolean;
  /** v4 only: the pool's hook contract, null for none. A pool with one can't be locked (HookedPool). */
  hooks: Address | null;
};

/** How one manager's list came out: where its ids came from, and whether it is all of them. */
export type ManagerNote = {
  manager: Address;
  name: string;
  source: "enumerable" | "explorer" | "recent";
  /** The list holds every position the wallet has there. */
  complete: boolean;
};

export type PositionsAnswer = { managers: AllowedManager[]; positions: Position[]; notes: ManagerNote[] };


export type PositionsDeps = {
  read: Read;
  getLogs: GetLogs;
  getBlockNumber: () => Promise<bigint>;
  /** The explorer's v2 API (`blockExplorers.default.apiUrl`); left out, only the RPC is asked. */
  apiUrl?: string;
  fetchFn?: typeof fetch;
  factory: Address;
  owner: Address;
  /** The managers to ask the factory about (POSITION_MANAGERS[network]). */
  candidates: readonly PositionManagerInfo[];
};

/** The kind the factory gives a manager (`managers(address)` answers `(allowed, kind)`), or null for any other value. */
export function kindOf(raw: unknown): PositionKind | null {
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  return n === 0 ? "v3" : n === 1 ? "v4" : null;
}

/** "0.3%", "0.05%", "1%", or "dynamic fee" for a v4 pool whose hook sets it. */
export function feeTierText(fee: number): string {
  if (fee === DYNAMIC_FEE) return "dynamic fee";
  return `${Number((fee / 10_000).toFixed(4))}%`;
}

/** "Uniswap v4 #328647". */
export function positionLabel(p: Pick<Position, "managerName" | "tokenId">): string {
  return `${p.managerName} #${p.tokenId}`;
}

/** "VTA/USDC · 0.3%". */
export function pairText(p: Pick<Position, "symbol0" | "symbol1" | "fee">): string {
  return `${p.symbol0}/${p.symbol1} · ${feeTierText(p.fee)}`;
}

/** Why the VaultFactory would refuse to lock a position, in the words Vault uses for its revert (errors.ts). */
export const POSITION_ISSUE = {
  noLiquidity: "This position holds no liquidity, so there is nothing to lock.",
  owed: "This position has tokens waiting to be collected. Collect them in Uniswap first, then lock it.",
  hooked: "This position is in a Uniswap v4 pool with hooks, which can't be locked.",
} as const;

/**
 * The factory's own checks on a position, before anything is signed: some liquidity (NoLiquidity), on v3 nothing in
 * `tokensOwed` (OwedNotCollected), on v4 no hook (HookedPool). Null when it can be locked.
 */
export function positionIssue(p: Pick<Position, "liquidity" | "owed" | "hooks">): string | null {
  if (p.liquidity === 0n) return POSITION_ISSUE.noLiquidity;
  if (p.owed) return POSITION_ISSUE.owed;
  if (p.hooks !== null) return POSITION_ISSUE.hooked;
  return null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const asAddress = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null);

/** The candidates the factory allows, each with the kind it gives it. Throws when the factory can't be read. */
export async function allowedManagers(read: Read, factory: Address, candidates: readonly PositionManagerInfo[]): Promise<AllowedManager[]> {
  if (candidates.length === 0) return [];
  const results = await read(candidates.map((c) => ({ address: factory, abi: vaultFactoryAbi, functionName: "managers", args: [c.address] })));
  return candidates.flatMap((c, i) => {
    const answer = ok(results[i]);
    if (!Array.isArray(answer) || answer[0] !== true) return [];
    const kind = kindOf(answer[1]);
    return kind ? [{ ...c, kind }] : [];
  });
}

/**
 * The ids the explorer lists for `owner` in `manager`'s collection, at most EXPLORER_PAGES pages. `complete` is true
 * once the explorer said there is no further page. Throws when the explorer doesn't answer. An item whose owner the
 * explorer names as someone else is left out; `ownerOf` decides in the end either way.
 */
export async function explorerIds(
  fetchFn: typeof fetch,
  apiUrl: string,
  manager: Address,
  owner: Address,
): Promise<{ ids: bigint[]; complete: boolean }> {
  const base = `${apiUrl}/tokens/${manager}/instances?holder_address_hash=${owner}`;
  const ids: bigint[] = [];
  let url = base;
  for (let page = 0; page < EXPLORER_PAGES; page++) {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`The explorer answered ${res.status}.`);
    const body = (await res.json()) as { items?: unknown; next_page_params?: unknown };
    if (!Array.isArray(body.items)) throw new Error("The explorer answered without a list.");
    for (const raw of body.items) {
      const item = (typeof raw === "object" && raw !== null ? raw : {}) as { id?: unknown; owner?: { hash?: unknown } | null };
      if (typeof item.id !== "string" || !UINT.test(item.id)) continue;
      const holder = typeof item.owner?.hash === "string" ? item.owner.hash : null;
      if (holder && !same(holder, owner)) continue;
      ids.push(BigInt(item.id));
    }
    const next = body.next_page_params;
    if (next === null || next === undefined) return { ids, complete: true };
    if (typeof next !== "object") return { ids, complete: false };
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") params.set(k, String(v));
    }
    url = `${base}&${params.toString()}`;
  }
  return { ids, complete: false };
}

/** The ids transferred to `owner` in `manager` over the last RECENT_BLOCKS, from the RPC's Transfer logs. */
export async function recentIds(getLogs: GetLogs, latest: bigint, manager: Address, owner: Address): Promise<bigint[]> {
  const fromBlock = latest > RECENT_BLOCKS ? latest - RECENT_BLOCKS : 0n;
  const logs = await getLogs({
    address: manager,
    topics: [TRANSFER_TOPIC, null, pad(owner.toLowerCase() as Hex, { size: 32 })],
    fromBlock,
    toBlock: latest,
  });
  return logs.flatMap((log) => {
    const id = log.topics[3];
    return typeof id === "string" && /^0x[0-9a-fA-F]{64}$/.test(id) ? [BigInt(id)] : [];
  });
}

/** Distinct ids, newest (largest) first. */
const distinctDesc = (ids: readonly bigint[]): bigint[] => [...new Set(ids)].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

/** The position each id holds, for those `read` can describe (a v3 id that was burned reverts and is left out). */
async function details(read: Read, m: AllowedManager, ids: readonly bigint[]): Promise<Omit<Position, "symbol0" | "symbol1">[]> {
  if (ids.length === 0) return [];
  const base = { manager: m.address, managerName: m.name, kind: m.kind };
  if (m.kind === "v3") {
    const results = await read(ids.map((id) => ({ address: m.address, abi: V3_POSITIONS_ABI, functionName: "positions", args: [id] })));
    return ids.flatMap((id, i) => {
      const r = ok(results[i]);
      if (!Array.isArray(r)) return [];
      const [currency0, currency1] = [asAddress(r[2]), asAddress(r[3])];
      if (!currency0 || !currency1 || typeof r[7] !== "bigint") return [];
      const owed = (typeof r[10] === "bigint" && r[10] > 0n) || (typeof r[11] === "bigint" && r[11] > 0n);
      return [{ ...base, tokenId: id.toString(), currency0, currency1, fee: Number(r[4]), liquidity: r[7], owed, hooks: null }];
    });
  }
  const results = await read(
    ids.flatMap((id) => [
      { address: m.address, abi: V4_POSITIONS_ABI, functionName: "getPoolAndPositionInfo", args: [id] },
      { address: m.address, abi: V4_POSITIONS_ABI, functionName: "getPositionLiquidity", args: [id] },
    ]),
  );
  return ids.flatMap((id, i) => {
    const info = ok(results[i * 2]);
    const liquidity = ok(results[i * 2 + 1]);
    const key = Array.isArray(info) ? (info[0] as { currency0?: unknown; currency1?: unknown; fee?: unknown; hooks?: unknown }) : null;
    const [currency0, currency1, hooks] = [asAddress(key?.currency0), asAddress(key?.currency1), asAddress(key?.hooks)];
    if (!currency0 || !currency1 || !hooks || typeof liquidity !== "bigint") return [];
    // An id the manager never minted answers an all-zero pool: there is no position there.
    if (currency0 === ZERO && currency1 === ZERO) return [];
    return [
      { ...base, tokenId: id.toString(), currency0, currency1, fee: Number(key?.fee ?? 0), liquidity, owed: false, hooks: hooks === ZERO ? null : hooks },
    ];
  });
}

/**
 * A currency's symbol, cleaned (a token's symbol is whatever its deployer chose), or its short address when it has
 * none; v4's native currency, address(0), is Arc's USDC. Each read stands alone (readEach), so a token that burns all
 * the gas it is given can't hide the others.
 */
export async function currencySymbols(read: Read, currencies: readonly Address[]): Promise<Map<string, string>> {
  const unique = [...new Set(currencies.map((c) => c.toLowerCase()))].map((c) => getAddress(c));
  const tokens = unique.filter((c) => c !== ZERO);
  const results = await readEach(read, tokens.map((t) => ({ address: t, abi: SYMBOL_ABI, functionName: "symbol" })));
  const out = new Map<string, string>([[ZERO, "USDC"]]);
  tokens.forEach((t, i) => {
    const symbol = ok(results[i]);
    out.set(t.toLowerCase(), cleanLabel(typeof symbol === "string" ? symbol : null, 32) ?? shortAddress(t));
  });
  return out;
}

/** Each currency's decimals (native USDC, address(0), has 18), null where the token doesn't answer; each read alone. */
export async function currencyDecimals(read: Read, currencies: readonly Address[]): Promise<Map<string, number | null>> {
  const tokens = [...new Set(currencies.map((c) => c.toLowerCase()))].filter((c) => c !== ZERO).map((c) => getAddress(c));
  const results = await readEach(read, tokens.map((t) => ({ address: t, abi: DECIMALS_ABI, functionName: "decimals" })));
  const out = new Map<string, number | null>([[ZERO, 18]]);
  tokens.forEach((t, i) => {
    const d = ok(results[i]);
    out.set(t.toLowerCase(), typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 255 ? d : null);
  });
  return out;
}

/** One position the wallet holds, for a manager and an id typed in: null when it isn't the wallet's or isn't there. */
export async function readPosition(read: Read, m: AllowedManager, tokenId: bigint, owner: Address): Promise<Position | "not-yours" | null> {
  const [holder] = await read([{ address: m.address, abi: POSITION_NFT_ABI, functionName: "ownerOf", args: [tokenId] }]);
  const who = asAddress(ok(holder));
  if (!who) return null;
  if (!same(who, owner)) return "not-yours";
  const [p] = await details(read, m, [tokenId]);
  if (!p) return null;
  const symbols = await currencySymbols(read, [p.currency0, p.currency1]);
  return { ...p, symbol0: symbols.get(p.currency0.toLowerCase()) ?? "?", symbol1: symbols.get(p.currency1.toLowerCase()) ?? "?" };
}

/** Every allowed manager's positions for the owner, as described in the module comment. */
export async function loadPositions(deps: PositionsDeps): Promise<PositionsAnswer> {
  const { read, owner } = deps;
  const managers = await allowedManagers(read, deps.factory, deps.candidates);
  if (managers.length === 0) return { managers, positions: [], notes: [] };

  const probes = await read(
    managers.flatMap((m) => [
      { address: m.address, abi: POSITION_NFT_ABI, functionName: "supportsInterface", args: [ERC721_ENUMERABLE] },
      { address: m.address, abi: POSITION_NFT_ABI, functionName: "balanceOf", args: [owner] },
    ]),
  );
  let latest: bigint | null = null;
  const notes: ManagerNote[] = [];
  const found: Omit<Position, "symbol0" | "symbol1">[] = [];

  for (const [i, m] of managers.entries()) {
    const enumerable = ok(probes[i * 2]) === true;
    const balance = ok(probes[i * 2 + 1]);
    const held = typeof balance === "bigint" ? balance : null;
    let ids: bigint[];
    let note: ManagerNote;
    if (enumerable && held !== null) {
      const count = held > BigInt(MAX_POSITIONS) ? MAX_POSITIONS : Number(held);
      const results = await read(
        Array.from({ length: count }, (_, k) => ({ address: m.address, abi: POSITION_NFT_ABI, functionName: "tokenOfOwnerByIndex", args: [owner, BigInt(k)] })),
      );
      ids = results.flatMap((r) => {
        const id = ok(r);
        return typeof id === "bigint" ? [id] : [];
      });
      note = { manager: m.address, name: m.name, source: "enumerable", complete: held <= BigInt(MAX_POSITIONS) && ids.length === count };
    } else {
      let fromExplorer: { ids: bigint[]; complete: boolean } | null = null;
      if (held !== 0n && deps.apiUrl) {
        try {
          fromExplorer = await explorerIds(deps.fetchFn ?? fetch, deps.apiUrl, m.address, owner);
        } catch {
          fromExplorer = null;
        }
      }
      let recent: bigint[] = [];
      if (held !== 0n) {
        try {
          latest ??= await deps.getBlockNumber();
          recent = await recentIds(deps.getLogs, latest, m.address, owner);
        } catch {
          recent = [];
        }
      }
      const candidates = distinctDesc([...(fromExplorer?.ids ?? []), ...recent]).slice(0, MAX_POSITIONS);
      const owners = candidates.length
        ? await read(candidates.map((id) => ({ address: m.address, abi: POSITION_NFT_ABI, functionName: "ownerOf", args: [id] })))
        : [];
      ids = candidates.filter((_, k) => {
        const who = asAddress(ok(owners[k]));
        return who !== null && same(who, owner);
      });
      // The manager's own count (v4's PositionManager answers `balanceOf`) says whether every position was found: a
      // lagging explorer, a failed one, or more than MAX_POSITIONS all leave the list short of it. Without a count,
      // only the explorer's "no further page" makes it whole.
      const complete = held !== null ? BigInt(ids.length) >= held : fromExplorer?.complete === true;
      note = { manager: m.address, name: m.name, source: fromExplorer || held === 0n ? "explorer" : "recent", complete };
    }
    notes.push(note);
    found.push(...(await details(read, m, distinctDesc(ids))));
  }

  const symbols = await currencySymbols(read, found.flatMap((p) => [p.currency0, p.currency1]));
  const positions = found.map((p) => ({
    ...p,
    symbol0: symbols.get(p.currency0.toLowerCase()) ?? "?",
    symbol1: symbols.get(p.currency1.toLowerCase()) ?? "?",
  }));
  return { managers, positions, notes };
}

/** What Finder says under a manager's positions when the list may not be all of them; null when it is. */
export function noteText(note: ManagerNote): string | null {
  if (note.complete) return null;
  if (note.source === "enumerable") return `${note.name}: showing the first ${MAX_POSITIONS} positions.`;
  if (note.source === "recent") {
    return `${note.name}: the explorer didn't answer, so only positions received in the last few minutes are listed. To lock another, type its id in Vault.`;
  }
  return `${note.name}: this may not be every position. To lock one that isn't listed, type its id in Vault.`;
}
