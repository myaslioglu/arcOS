import { BURN_ADDRESSES, explorerUrl, type Address, type NetworkId } from "@arcos/chain";
import { amountToString } from "./amounts";
import type { AlertDetail, AlertKind, WatchStateDoc, WatchStateRecord } from "./docs";
import { LIQUIDITY_DROP } from "./names";
import type { TimestampLike } from "./timestamps";

// Watchdog's rules, pure: what one check of a watched token observed, which alerts that observation raises against the
// stored state, what of the state to write, and the words of an alert. The indexer reads the chain and writes
// Firestore around these; nothing here does either.

/** One chain read's outcome. `ok: false` is unread: a transport failure, a timeout, a rejected aggregate or a malformed
 * slot word. Unread keeps the stored value and never alerts. `ok: true` with `null` is absent: the call reverted or did
 * not decode inside an aggregate that answered, the implementation slot is zero, or no deepest pool is known. */
export type Read<T> = { ok: true; value: T } | { ok: false };

/** What one check read of a token, every read pinned to `block`. */
export type WatchObservation = {
  block: number;
  owner: Read<Address | null>;
  totalSupply: Read<bigint | null>;
  paused: Read<boolean | null>;
  implementation: Read<Address | null>;
  /** The deepest pool's id and its depth in the quote's 6-decimal units. */
  pool: Read<{ id: string; depth: bigint } | null>;
  /** How the token labels itself, for the alert copy. Never decides an alert. */
  label: { symbol: string | null; decimals: number | null; quote: "USDC" | "EURC" | null };
};

/** An alert before it is written: what the alerts doc holds that the store doesn't add (ids, times, fan-out). */
export type AlertDraft = { kind: AlertKind; block: number; detail: AlertDetail };

/** The fields a check writes to watchState. Never `network`, `token` or `watchers`: those belong to the watch transactions. */
export type WatchStatePatch = Partial<Pick<WatchStateRecord, "owner" | "totalSupply" | "paused" | "implementation" | "bestPool" | "bestPoolDepth">> & {
  checkedBlock: number;
  lastCheckedAt: TimestampLike;
};

/** Whether a watchState doc has ever been observed: a watch creates it at block 0, and the first check fills it in. */
export const seen = (state: Pick<WatchStateRecord, "checkedBlock">): boolean => state.checkedBlock > 0;

const lower = (a: string): string => a.toLowerCase();
const burn = new Set(BURN_ADDRESSES.map(lower));
export const isBurnAddress = (a: string): boolean => burn.has(lower(a));
/** Every burn address is one owner, "burn", so 0x0 → 0x…dEaD is no change of owner. */
const ownerKey = (a: string): string => (isBurnAddress(a) ? "burn" : lower(a));

const detail = (label: WatchObservation["label"], over: Partial<AlertDetail> = {}): AlertDetail => ({
  symbol: label.symbol,
  decimals: label.decimals,
  from: null,
  to: null,
  quote: label.quote,
  pool: null,
  renounced: false,
  pct: null,
  ...over,
});

/**
 * The alerts an observation raises against the stored state, in a fixed order: owner, supply, pause, implementation,
 * liquidity. None on first sight (`prev` null), and none for a block at or before the stored one. A field that was not
 * read (`ok: false`) raises nothing, whatever it was before.
 */
export function diffWatchState(prev: WatchStateRecord | null, obs: WatchObservation): AlertDraft[] {
  if (prev === null || obs.block <= prev.checkedBlock) return [];
  const drafts: AlertDraft[] = [];
  const draft = (kind: AlertKind, over: Partial<AlertDetail>) => drafts.push({ kind, block: obs.block, detail: detail(obs.label, over) });

  // Both owners known. null on either side (the call reverted, or started to) says nothing about a change of hands.
  if (obs.owner.ok && obs.owner.value !== null && prev.owner !== null && ownerKey(prev.owner) !== ownerKey(obs.owner.value)) {
    const to = lower(obs.owner.value);
    draft("owner_changed", { from: lower(prev.owner), to, renounced: isBurnAddress(to) });
  }

  if (obs.totalSupply.ok && obs.totalSupply.value !== null && prev.totalSupply !== null && obs.totalSupply.value > prev.totalSupply) {
    draft("supply_increased", { from: amountToString(prev.totalSupply), to: amountToString(obs.totalSupply.value) });
  }

  if (obs.paused.ok && obs.paused.value !== null && prev.paused !== null && obs.paused.value !== prev.paused) {
    draft(obs.paused.value ? "paused" : "unpaused", {});
  }

  // A slot read is deterministic, so null ↔ address is a real change: the proxy gained or lost its implementation.
  if (obs.implementation.ok) {
    const from = prev.implementation === null ? null : lower(prev.implementation);
    const to = obs.implementation.value === null ? null : lower(obs.implementation.value);
    if (from !== to) draft("implementation_changed", { from, to });
  }

  if (obs.pool.ok && obs.pool.value !== null && prev.bestPool !== null && prev.bestPoolDepth !== null && prev.bestPoolDepth > 0n) {
    const { id, depth } = obs.pool.value;
    if (lower(id) === lower(prev.bestPool)) {
      const drop = prev.bestPoolDepth - depth;
      if (drop >= LIQUIDITY_DROP.minUnits && drop * 10_000n >= prev.bestPoolDepth * LIQUIDITY_DROP.bps) {
        draft("liquidity_dropped", {
          from: amountToString(prev.bestPoolDepth),
          to: amountToString(depth),
          pool: lower(id),
          pct: Number((drop * 100n) / prev.bestPoolDepth),
        });
      }
    }
  }

  return drafts;
}

const sameAddress = (a: Address | null, b: Address | null): boolean => (a === null || b === null ? a === b : lower(a) === lower(b));
const lowerOrNull = (a: Address | null): Address | null => (a === null ? null : (lower(a) as Address));

/**
 * What to write to watchState after a check, or null for nothing. On first sight the four core reads (owner, total
 * supply, paused, implementation) must all be ok, or the doc stays unseen and the next run tries again; an unread pool
 * is stored as none. Later, an unread field is left as it is, and the patch carries only the fields that changed, with
 * the block they were read at and `now`: no change, no write. A block at or before the stored one writes nothing.
 */
export function nextWatchState(prev: WatchStateRecord | null, obs: WatchObservation, now: TimestampLike): WatchStatePatch | null {
  if (prev === null) {
    if (!obs.owner.ok || !obs.totalSupply.ok || !obs.paused.ok || !obs.implementation.ok) return null;
    const pool = obs.pool.ok ? obs.pool.value : null;
    return {
      owner: lowerOrNull(obs.owner.value),
      totalSupply: obs.totalSupply.value,
      paused: obs.paused.value,
      implementation: lowerOrNull(obs.implementation.value),
      bestPool: pool === null ? null : lower(pool.id),
      bestPoolDepth: pool === null ? null : pool.depth,
      checkedBlock: obs.block,
      lastCheckedAt: now,
    };
  }
  if (obs.block <= prev.checkedBlock) return null;

  const patch: Partial<WatchStatePatch> = {};
  if (obs.owner.ok && !sameAddress(prev.owner, obs.owner.value)) patch.owner = lowerOrNull(obs.owner.value);
  if (obs.totalSupply.ok && prev.totalSupply !== obs.totalSupply.value) patch.totalSupply = obs.totalSupply.value;
  if (obs.paused.ok && prev.paused !== obs.paused.value) patch.paused = obs.paused.value;
  if (obs.implementation.ok && !sameAddress(prev.implementation, obs.implementation.value)) {
    patch.implementation = lowerOrNull(obs.implementation.value);
  }
  if (obs.pool.ok) {
    const pool = obs.pool.value;
    const id = pool === null ? null : lower(pool.id);
    const depth = pool === null ? null : pool.depth;
    if (id !== prev.bestPool) patch.bestPool = id;
    if (depth !== prev.bestPoolDepth) patch.bestPoolDepth = depth;
  }
  if (Object.keys(patch).length === 0) return null;
  return { ...patch, checkedBlock: obs.block, lastCheckedAt: now };
}

/** The patch as Firestore stores it: amounts as decimal strings. What `update(watchStateRef, …)` takes. */
export function watchStatePatchToDoc(patch: WatchStatePatch): Partial<WatchStateDoc> {
  const { totalSupply, bestPoolDepth, ...rest } = patch;
  return {
    ...rest,
    ...(totalSupply === undefined ? {} : { totalSupply: totalSupply === null ? null : amountToString(totalSupply) }),
    ...(bestPoolDepth === undefined ? {} : { bestPoolDepth: bestPoolDepth === null ? null : amountToString(bestPoolDepth) }),
  };
}

/** How many code points of a symbol an alert shows. */
export const SYMBOL_MAX_LENGTH = 16;

/**
 * A symbol as an alert may show it. Symbols are whatever the deployer chose, so: NFKC; every control, format (bidi
 * overrides, zero-width joiners), surrogate, private-use and unassigned code point and every line or paragraph
 * separator removed; whitespace collapsed; trimmed; at most 16 code points. Nothing left is null.
 */
export function sanitizeSymbol(symbol: string | null | undefined): string | null {
  if (typeof symbol !== "string") return null;
  const cleaned = symbol
    .normalize("NFKC")
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const cut = [...cleaned].slice(0, SYMBOL_MAX_LENGTH).join("").trim();
  return cut === "" ? null : cut;
}

/** 0x1234…abcd: six characters, an ellipsis, four characters. */
export const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const grouped = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A raw amount in whole and fraction units, comma-grouped, at most `fractionDigits` fraction digits, truncated. */
export function formatUnits(raw: bigint, decimals: number, fractionDigits = 4): string {
  const scale = 10n ** BigInt(decimals);
  const whole = grouped((raw / scale).toString());
  const fraction = (raw % scale).toString().padStart(decimals, "0").slice(0, fractionDigits).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

const amountOf = (text: string | null): bigint => (text === null ? 0n : BigInt(text));
const supplyText = (text: string | null, decimals: number | null): string =>
  decimals === null ? `${grouped(amountOf(text).toString())} raw units` : formatUnits(amountOf(text), decimals);
const quoteUnits = (text: string | null): string => grouped((amountOf(text) / 1_000_000n).toString());
const addressOrNone = (a: string | null): string => (a === null ? "none" : short(a));

export type AlertTextInput = { kind: AlertKind; token: string; network: NetworkId; block: number; detail: AlertDetail };

/**
 * The words of an alert, and the explorer link that goes with them. The copy is fixed and plain: the token, what
 * changed, from what to what, at which block. The symbol is sanitised here, so a stored symbol is shown safely whatever
 * it holds.
 */
export function alertText({ kind, token, network, block, detail }: AlertTextInput): { text: string; link: string } {
  const link = explorerUrl("token", token, network);
  const symbol = sanitizeSymbol(detail.symbol);
  const T = symbol === null ? short(token) : `${symbol} (${short(token)})`;
  const N = grouped(String(block));
  const at = `at block ${N}`;
  let text: string;
  switch (kind) {
    case "owner_changed": {
      const change = `owner changed from ${addressOrNone(detail.from)} to ${addressOrNone(detail.to)} ${at}`;
      text = detail.renounced ? `${T}: ownership renounced, ${change}` : `${T}: ${change}`;
      break;
    }
    case "supply_increased":
      text = `${T}: total supply increased from ${supplyText(detail.from, detail.decimals)} to ${supplyText(detail.to, detail.decimals)} ${at}`;
      break;
    case "paused":
      text = `${T}: paused ${at}`;
      break;
    case "unpaused":
      text = `${T}: unpaused ${at}`;
      break;
    case "implementation_changed":
      text = `${T}: implementation changed from ${addressOrNone(detail.from)} to ${addressOrNone(detail.to)} ${at}`;
      break;
    case "liquidity_dropped":
      text = `${T}: deepest pool's ${detail.quote ?? "liquidity"} fell from ${quoteUnits(detail.from)} to ${quoteUnits(detail.to)} (${detail.pct ?? 0}% lower) ${at}`;
      break;
    default:
      text = `${T}: ${(kind as string).replace(/_/g, " ")} ${at}`;
  }
  return { text, link };
}
