import { describe, expect, it, vi } from "vitest";
import type { BridgeResult, BridgeStep } from "@circle-fin/app-kit";
import { UNFINISHED_KEY, burnStepOf, createUnfinishedStore, readUnfinished, unfinishedFromResult, type StorageLike, type UnfinishedTransfer } from "../unfinished";

const BURN = "0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b";
const OTHER = `0x${"22".repeat(32)}`;

/** A storage as plain as it gets: a Map behind the three methods the store uses. */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const entry: UnfinishedTransfer = { source: "Arc", dest: "Base", burnTxHash: BURN, amount: "9", startedAt: 1_759_480_000_000 };

describe("readUnfinished", () => {
  it("reads what was stored, and nothing from no storage, nothing stored, or junk", () => {
    expect(readUnfinished(memoryStorage({ [UNFINISHED_KEY]: JSON.stringify([entry]) }))).toEqual([entry]);
    expect(readUnfinished(undefined)).toEqual([]);
    expect(readUnfinished(memoryStorage())).toEqual([]);
    expect(readUnfinished(memoryStorage({ [UNFINISHED_KEY]: "{not json" }))).toEqual([]);
    expect(readUnfinished(memoryStorage({ [UNFINISHED_KEY]: JSON.stringify({ a: 1 }) }))).toEqual([]);
  });

  it("drops an entry that isn't whole, keeps the rest", () => {
    const stored = [entry, { ...entry, burnTxHash: "0x12" }, { ...entry, amount: 9 }, { ...entry, startedAt: "yesterday" }, null, "x"];
    expect(readUnfinished(memoryStorage({ [UNFINISHED_KEY]: JSON.stringify(stored) }))).toEqual([entry]);
  });

  it("reads nothing from a storage that throws", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readUnfinished(storage)).toEqual([]);
  });
});

describe("createUnfinishedStore", () => {
  it("remembers, replaces by burn hash, forgets, and tells its subscribers each time", () => {
    const storage = memoryStorage();
    const store = createUnfinishedStore(() => storage);
    const changes = vi.fn();
    store.subscribe(changes);

    expect(store.getSnapshot()).toEqual([]);
    store.remember(entry);
    expect(store.getSnapshot()).toEqual([entry]);
    expect(JSON.parse(storage.map.get(UNFINISHED_KEY)!)).toEqual([entry]);

    store.remember({ ...entry, burnTxHash: BURN.toUpperCase().replace("0X", "0x") as `0x${string}`, amount: "9.5" });
    expect(store.getSnapshot()).toEqual([{ ...entry, amount: "9.5" }]);

    store.remember({ ...entry, burnTxHash: OTHER as `0x${string}` });
    expect(store.getSnapshot()).toHaveLength(2);

    store.forget(BURN);
    expect(store.getSnapshot()).toEqual([{ ...entry, burnTxHash: OTHER }]);
    store.forget(OTHER);
    expect(store.getSnapshot()).toEqual([]);
    expect(storage.map.has(UNFINISHED_KEY), "an empty list is removed, not stored").toBe(false);
    expect(changes).toHaveBeenCalledTimes(5);

    store.forget(BURN);
    expect(changes, "forgetting what isn't there changes nothing").toHaveBeenCalledTimes(5);
  });

  it("gives the same snapshot until something changes, as useSyncExternalStore needs", () => {
    const store = createUnfinishedStore(() => memoryStorage({ [UNFINISHED_KEY]: JSON.stringify([entry]) }));
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    expect(store.getServerSnapshot()).toEqual([]);
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
  });

  it("works without any storage, in memory only", () => {
    const store = createUnfinishedStore(() => undefined);
    store.remember(entry);
    expect(store.getSnapshot()).toEqual([entry]);
    store.forget(BURN);
    expect(store.getSnapshot()).toEqual([]);
  });
});

const step = (over: Partial<BridgeStep>): BridgeStep => ({ name: "burn", state: "success", txHash: BURN, ...over });

describe("burnStepOf", () => {
  it("finds the successful burn with a hash, by its name in any casing", () => {
    expect(burnStepOf([step({ name: "approve", txHash: OTHER as `0x${string}` }), step({ name: "Burn" })])?.txHash).toBe(BURN);
  });

  it("finds nothing in a failed burn, one with no hash, or the approval alone", () => {
    expect(burnStepOf([step({ state: "error" })])).toBeNull();
    expect(burnStepOf([step({ txHash: undefined })])).toBeNull();
    expect(burnStepOf([step({ name: "approve" })])).toBeNull();
    expect(burnStepOf([])).toBeNull();
  });
});

describe("unfinishedFromResult", () => {
  const route = { source: "Arc" as const, dest: "Base" as const, amount: "9", startedAt: 5 };
  const result = (state: BridgeResult["state"], steps: BridgeStep[]) => ({ state, steps }) as unknown as BridgeResult;

  it("is the burn of a result that stopped after it, or is still pending", () => {
    const steps = [step({ name: "approve", txHash: OTHER as `0x${string}` }), step({}), step({ name: "mint", state: "error", txHash: undefined })];
    expect(unfinishedFromResult(result("error", steps), route)).toEqual({ ...route, burnTxHash: BURN });
    expect(unfinishedFromResult(result("pending", steps), route)).toEqual({ ...route, burnTxHash: BURN });
  });

  it("is nothing for a bridge that minted, or one that never burned", () => {
    expect(unfinishedFromResult(result("success", [step({})]), route)).toBeNull();
    expect(unfinishedFromResult(result("error", [step({ name: "approve" }), step({ state: "error" })]), route)).toBeNull();
  });
});
