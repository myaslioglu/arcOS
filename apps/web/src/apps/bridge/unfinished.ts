import type { BridgeResult, BridgeStep } from "@circle-fin/app-kit";
import type { Hex } from "viem";
import type { ChainId } from "./chains";

/**
 * Transfers whose burn landed but whose mint hasn't, kept in the browser's localStorage so a wallet that crashed on the
 * mint, or a page closed in the middle, doesn't lose the one thing a finish needs: the burn hash (apps/bridge/finish.ts).
 * The in-memory session (session.ts) survives a closed window; this survives a closed page and a crashed wallet app.
 *
 * An entry is written the moment the kit reports the burn step done (`kit.on('bridge.burn')`), again from the final
 * result in case the event was missed, and removed once the transfer is minted: by the bridge itself, by a Finish, or
 * when the destination chain says the message was already received (finish.ts's `isDelivered`).
 */
export type UnfinishedTransfer = {
  source: ChainId;
  dest: ChainId;
  burnTxHash: Hex;
  /** USDC, as the amount box had it. */
  amount: string;
  /** When the bridge was started, ms since the epoch. */
  startedAt: number;
};

export const UNFINISHED_KEY = "arcos.bridge.unfinished";

/** The slice of `Storage` the store uses, so tests inject a plain object instead of a DOM. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);

/** One stored entry, checked field by field: anything else in the list is dropped, never trusted. */
function readEntry(raw: unknown): UnfinishedTransfer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { source, dest, burnTxHash, amount, startedAt } = raw as Record<string, unknown>;
  if (typeof source !== "string" || typeof dest !== "string" || !isHash(burnTxHash)) return null;
  if (typeof amount !== "string" || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  return { source: source as ChainId, dest: dest as ChainId, burnTxHash, amount, startedAt };
}

/** Every well-formed entry in storage, oldest first; an empty list when there is no storage, nothing stored, or junk. */
export function readUnfinished(storage: StorageLike | undefined): UnfinishedTransfer[] {
  try {
    const raw = storage?.getItem(UNFINISHED_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.map(readEntry).filter((e): e is UnfinishedTransfer => e !== null);
  } catch {
    return [];
  }
}

function writeUnfinished(storage: StorageLike | undefined, list: UnfinishedTransfer[]): void {
  try {
    if (list.length === 0) storage?.removeItem(UNFINISHED_KEY);
    else storage?.setItem(UNFINISHED_KEY, JSON.stringify(list));
  } catch {
    // Storage that refuses (private mode, quota) loses nothing the session doesn't still hold.
  }
}

/** The burn step of a result that succeeded and has a hash: the one transaction a finish can start from. */
export function burnStepOf(steps: readonly BridgeStep[]): BridgeStep | null {
  return steps.find((s) => s.state === "success" && /burn/i.test(s.name) && isHash(s.txHash?.toLowerCase())) ?? null;
}

/**
 * The entry a finished `kit.bridge()` call leaves behind, or null: a result that minted (`state: 'success'`) leaves
 * nothing, one that stopped or is still pending after its burn leaves the burn. `source`, `dest` and `amount` are the
 * session's, not read back out of the result, so they match what the window showed.
 */
export function unfinishedFromResult(result: BridgeResult, route: { source: ChainId; dest: ChainId; amount: string; startedAt: number }): UnfinishedTransfer | null {
  if (result.state === "success") return null;
  const burn = burnStepOf(result.steps);
  if (!burn) return null;
  return { ...route, burnTxHash: burn.txHash!.toLowerCase() as Hex };
}

/**
 * The store the window subscribes to (`useSyncExternalStore`): one list, re-read from storage only when this page
 * changes it, so a snapshot is stable between changes. `storage` is resolved on each access, so the module loads on the
 * server (no `localStorage` there) and in the node test environment.
 */
export function createUnfinishedStore(storage?: () => StorageLike | undefined) {
  const resolve = storage ?? (() => (typeof localStorage === "undefined" ? undefined : localStorage));
  let snapshot: UnfinishedTransfer[] | null = null;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function getSnapshot(): UnfinishedTransfer[] {
    if (snapshot === null) snapshot = readUnfinished(resolve());
    return snapshot;
  }

  /** The server's snapshot: nothing, so the server's HTML and the first client render agree. */
  function getServerSnapshot(): UnfinishedTransfer[] {
    return EMPTY;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Adds an entry, or replaces the one with the same burn hash. */
  function remember(entry: UnfinishedTransfer): void {
    const hash = entry.burnTxHash.toLowerCase();
    const rest = getSnapshot().filter((e) => e.burnTxHash.toLowerCase() !== hash);
    snapshot = [...rest, { ...entry, burnTxHash: hash as Hex }];
    writeUnfinished(resolve(), snapshot);
    emit();
  }

  /** Removes the entry with that burn hash; nothing happens when there is none. */
  function forget(burnTxHash: string): void {
    const hash = burnTxHash.toLowerCase();
    const current = getSnapshot();
    const rest = current.filter((e) => e.burnTxHash.toLowerCase() !== hash);
    if (rest.length === current.length) return;
    snapshot = rest;
    writeUnfinished(resolve(), snapshot);
    emit();
  }

  return { getSnapshot, getServerSnapshot, subscribe, remember, forget };
}

const EMPTY: UnfinishedTransfer[] = [];

export const unfinished = createUnfinishedStore();
