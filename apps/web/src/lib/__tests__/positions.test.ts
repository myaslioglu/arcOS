import { describe, expect, it, vi } from "vitest";
import { pad, type Address, type Hex } from "viem";
import { POSITION_MANAGERS } from "@arcos/chain";
import {
  ERC721_ENUMERABLE,
  EXPLORER_PAGES,
  MAX_POSITIONS,
  POSITION_ISSUE,
  RECENT_BLOCKS,
  TRANSFER_TOPIC,
  allowedManagers,
  currencyDecimals,
  currencySymbols,
  explorerIds,
  feeTierText,
  kindOf,
  loadPositions,
  noteText,
  pairText,
  positionIssue,
  positionLabel,
  readPosition,
  recentIds,
  type GetLogs,
} from "../positions";
import type { ContractRead, Read, ReadResult } from "../reads";

const FACTORY: Address = "0x2aA12f98795E7A65072950AfbA9d1E023D398241";
const OWNER: Address = "0x7e57000000000000000000000000000000000001";
const OTHER: Address = "0x2222222222222222222222222222222222222222";
const V3: Address = "0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377";
const V4: Address = "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B";
const TA: Address = "0xBFF22091be481B41C8CA49862653aBA216bAc041";
const TB: Address = "0xF4F40da2D2b7F0a2C5d2d3E113dDfBEB3FfDCa5E";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const HOOK: Address = "0x0000000000000000000000000000000000A00800"; // checksummed, as getAddress gives it
const CANDIDATES = POSITION_MANAGERS.mainnet;

type Answer = unknown | Error;
/** A fake chain: each call answered from `answers`, keyed `<address>.<function>(<args>)` in lower case. */
function chain(answers: Record<string, Answer>) {
  const keyOf = (c: ContractRead) =>
    `${c.address}.${c.functionName}(${(c.args ?? []).map((a) => (typeof a === "string" ? a : String(a))).join(",")})`.toLowerCase();
  const asked: string[] = [];
  const read: Read = async (calls) =>
    calls.map((c): ReadResult => {
      const key = keyOf(c);
      asked.push(key);
      if (!(key in answers)) return { status: "failure", error: new Error(`no answer for ${key}`) };
      const value = answers[key];
      return value instanceof Error ? { status: "failure", error: value } : { status: "success", result: value };
    });
  return { read, asked };
}
const k = (address: string, fn: string, ...args: unknown[]) => `${address}.${fn}(${args.map(String).join(",")})`.toLowerCase();

const v3Position = (token0: Address, token1: Address, liquidity: bigint, owed0 = 0n, owed1 = 0n) => [
  0n, ZERO, token0, token1, 3000, -887220, 887220, liquidity, 0n, 0n, owed0, owed1,
];
const v4Key = (currency0: Address, currency1: Address, hooks: Address = ZERO) => [{ currency0, currency1, fee: 3000, tickSpacing: 60, hooks }, 0n];

describe("small helpers", () => {
  it("reads the factory's kinds: 0 is v3, 1 is v4, anything else nothing", () => {
    expect(kindOf(0)).toBe("v3");
    expect(kindOf(1)).toBe("v4");
    expect(kindOf(1n)).toBe("v4");
    expect(kindOf(2)).toBeNull();
    expect(kindOf(undefined)).toBeNull();
  });

  it("writes fee tiers and labels", () => {
    expect(feeTierText(3000)).toBe("0.3%");
    expect(feeTierText(500)).toBe("0.05%");
    expect(feeTierText(100)).toBe("0.01%");
    expect(feeTierText(10_000)).toBe("1%");
    expect(feeTierText(0x800000)).toBe("dynamic fee");
    expect(positionLabel({ managerName: "Uniswap v4", tokenId: "328647" })).toBe("Uniswap v4 #328647");
    expect(pairText({ symbol0: "USDC", symbol1: "VTB", fee: 3000 })).toBe("USDC/VTB · 0.3%");
  });

  it("says why the factory would refuse a position, in its own order", () => {
    expect(positionIssue({ liquidity: 0n, owed: true, hooks: HOOK })).toBe(POSITION_ISSUE.noLiquidity);
    expect(positionIssue({ liquidity: 1n, owed: true, hooks: null })).toBe(POSITION_ISSUE.owed);
    expect(positionIssue({ liquidity: 1n, owed: false, hooks: HOOK })).toBe(POSITION_ISSUE.hooked);
    expect(positionIssue({ liquidity: 1n, owed: false, hooks: null })).toBeNull();
  });
});

describe("allowedManagers: the factory's per-address view, asked about each known candidate", () => {
  it("keeps the allowed ones with the kind the factory gives them", async () => {
    const { read } = chain({ [k(FACTORY, "managers", V3)]: [true, 0], [k(FACTORY, "managers", V4)]: [true, 1] });
    expect(await allowedManagers(read, FACTORY, CANDIDATES)).toEqual([
      { ...CANDIDATES[0], kind: "v3" },
      { ...CANDIDATES[1], kind: "v4" },
    ]);
  });

  it("drops a disallowed one, one of an unknown kind, and one whose read failed", async () => {
    const { read } = chain({ [k(FACTORY, "managers", V3)]: [false, 0], [k(FACTORY, "managers", V4)]: [true, 7] });
    expect(await allowedManagers(read, FACTORY, CANDIDATES)).toEqual([]);
    expect(await allowedManagers(chain({}).read, FACTORY, CANDIDATES)).toEqual([]);
  });
});

describe("explorerIds: Blockscout's list of a collection's tokens the owner holds", () => {
  const api = "https://explorer.example/api/v2";
  const page = (ids: string[], next: unknown = null, owner: string = OWNER) =>
    new Response(JSON.stringify({ items: ids.map((id) => ({ id, owner: { hash: owner } })), next_page_params: next }));

  it("asks for the manager's instances held by the owner, and is complete when there is no next page", async () => {
    const fetchFn = vi.fn<(url: string) => Promise<Response>>(async () => page(["7", "9"]));
    expect(await explorerIds(fetchFn as unknown as typeof fetch, api, V4, OWNER)).toEqual({ ids: [7n, 9n], complete: true });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${api}/tokens/${V4}/instances?holder_address_hash=${OWNER}`);
  });

  it("follows next_page_params for at most EXPLORER_PAGES pages", async () => {
    const fetchFn = vi.fn<(url: string) => Promise<Response>>(async () => page(["1"], { unique_token: 1, items_count: 50 }));
    const answer = await explorerIds(fetchFn as unknown as typeof fetch, api, V4, OWNER);
    expect(fetchFn).toHaveBeenCalledTimes(EXPLORER_PAGES);
    expect(fetchFn.mock.calls[1]?.[0]).toBe(`${api}/tokens/${V4}/instances?holder_address_hash=${OWNER}&unique_token=1&items_count=50`);
    expect(answer.complete).toBe(false);
  });

  it("skips junk ids and items another owner holds", async () => {
    const body = { items: [{ id: "01" }, { id: "x" }, { id: 5 }, { id: "6", owner: { hash: OTHER } }, { id: "8", owner: null }], next_page_params: null };
    const fetchFn = async () => new Response(JSON.stringify(body));
    expect(await explorerIds(fetchFn as unknown as typeof fetch, api, V4, OWNER)).toEqual({ ids: [8n], complete: true });
  });

  it("throws on an error status or a body without a list", async () => {
    await expect(explorerIds((async () => new Response("down", { status: 503 })) as unknown as typeof fetch, api, V4, OWNER)).rejects.toThrow();
    await expect(explorerIds((async () => new Response("{}")) as unknown as typeof fetch, api, V4, OWNER)).rejects.toThrow();
  });
});

describe("recentIds: Transfer logs to the owner over the last RECENT_BLOCKS", () => {
  it("asks the manager for Transfer(any, owner, id) over a bounded range, and reads the ids", async () => {
    const getLogs = vi.fn<GetLogs>(async () => [
      { topics: [TRANSFER_TOPIC, pad(ZERO), pad(OWNER), pad("0x0503f7" as Hex)] },
      { topics: [TRANSFER_TOPIC, pad(ZERO), pad(OWNER)] },
    ]);
    expect(await recentIds(getLogs, 10_000n, V4, OWNER)).toEqual([0x0503f7n]);
    expect(getLogs).toHaveBeenCalledWith({
      address: V4,
      topics: [TRANSFER_TOPIC, null, pad(OWNER.toLowerCase() as Hex, { size: 32 })],
      fromBlock: 10_000n - RECENT_BLOCKS,
      toBlock: 10_000n,
    });
    await recentIds(getLogs, 5n, V4, OWNER);
    expect(getLogs.mock.calls[1]?.[0].fromBlock).toBe(0n);
  });
});

describe("currencies", () => {
  it("names each currency by its cleaned symbol, native USDC as USDC, and an unnamed one by its address", async () => {
    const { read } = chain({ [k(TA, "symbol")]: "V\u200bTA", [k(TB, "symbol")]: new Error("revert") });
    const symbols = await currencySymbols(read, [TA, TB, ZERO, TA]);
    expect(symbols.get(TA.toLowerCase())).toBe("VTA");
    expect(symbols.get(TB.toLowerCase())).toBe("0xF4F4…Ca5E");
    expect(symbols.get(ZERO)).toBe("USDC");
  });

  it("reads decimals, 18 for native USDC, null where unknown", async () => {
    const { read } = chain({ [k(TA, "decimals")]: 6, [k(TB, "decimals")]: 300 });
    const decimals = await currencyDecimals(read, [TA, TB, ZERO]);
    expect([decimals.get(TA.toLowerCase()), decimals.get(TB.toLowerCase()), decimals.get(ZERO)]).toEqual([6, null, 18]);
  });
});

describe("loadPositions", () => {
  const base = {
    [k(FACTORY, "managers", V3)]: [true, 0],
    [k(FACTORY, "managers", V4)]: [true, 1],
    [k(V3, "supportsInterface", ERC721_ENUMERABLE)]: true,
    [k(V4, "supportsInterface", ERC721_ENUMERABLE)]: false,
    [k(TA, "symbol")]: "VTA",
    [k(TB, "symbol")]: "VTB",
  };
  const v3Answers = {
    [k(V3, "balanceOf", OWNER)]: 2n,
    [k(V3, "tokenOfOwnerByIndex", OWNER, 0)]: 11n,
    [k(V3, "tokenOfOwnerByIndex", OWNER, 1)]: 12n,
    [k(V3, "positions", 11)]: v3Position(TA, TB, 5n),
    [k(V3, "positions", 12)]: v3Position(TA, TB, 5n, 1n, 0n),
  };
  const v4Answers = {
    [k(V4, "balanceOf", OWNER)]: 3n,
    [k(V4, "ownerOf", 21)]: OWNER,
    [k(V4, "ownerOf", 22)]: OWNER,
    [k(V4, "ownerOf", 23)]: OWNER,
    [k(V4, "ownerOf", 24)]: OTHER,
    [k(V4, "getPoolAndPositionInfo", 21)]: v4Key(TA, TB),
    [k(V4, "getPositionLiquidity", 21)]: 7n,
    [k(V4, "getPoolAndPositionInfo", 22)]: v4Key(ZERO, TA),
    [k(V4, "getPositionLiquidity", 22)]: 8n,
    [k(V4, "getPoolAndPositionInfo", 23)]: v4Key(TA, TB, HOOK),
    [k(V4, "getPositionLiquidity", 23)]: 9n,
  };
  const explorer = (ids: string[], status = 200) =>
    (async () =>
      status === 200
        ? new Response(JSON.stringify({ items: ids.map((id) => ({ id, owner: { hash: OWNER } })), next_page_params: null }))
        : new Response("down", { status })) as unknown as typeof fetch;
  const deps = (answers: Record<string, Answer>, over: Partial<Parameters<typeof loadPositions>[0]> = {}) => ({
    ...chain({ ...base, ...answers }),
    getLogs: (async () => []) as GetLogs,
    getBlockNumber: async () => 100_000n,
    apiUrl: "https://explorer.example/api/v2",
    fetchFn: explorer([]),
    factory: FACTORY,
    owner: OWNER,
    candidates: CANDIDATES,
    ...over,
  });

  it("lists an enumerable manager's positions from the manager itself, newest first, and says what a v3 position owes", async () => {
    const d = deps({ ...v3Answers, [k(V4, "balanceOf", OWNER)]: 0n });
    const answer = await loadPositions(d);
    expect(answer.positions.map((p) => [p.managerName, p.tokenId, p.owed, positionIssue(p)])).toEqual([
      ["Uniswap v3", "12", true, POSITION_ISSUE.owed],
      ["Uniswap v3", "11", false, null],
    ]);
    expect(answer.positions[1]).toMatchObject({ kind: "v3", currency0: TA, currency1: TB, symbol0: "VTA", symbol1: "VTB", fee: 3000, liquidity: 5n, hooks: null });
    expect(answer.notes).toEqual([
      { manager: V3, name: "Uniswap v3", source: "enumerable", complete: true },
      { manager: V4, name: "Uniswap v4", source: "explorer", complete: true },
    ]);
    // A wallet with no v4 position asks neither the explorer nor the logs.
    expect(d.asked.some((key) => key.includes(".ownerof("))).toBe(false);
  });

  it("finds a non-enumerable manager's positions through the explorer, keeps those ownerOf confirms, and reads each pool", async () => {
    const answer = await loadPositions(deps({ [k(V3, "balanceOf", OWNER)]: 0n, ...v4Answers }, { fetchFn: explorer(["21", "22", "23", "24"]) }));
    expect(answer.positions.map((p) => p.tokenId)).toEqual(["23", "22", "21"]);
    const [hooked, native, plain] = answer.positions;
    expect(hooked).toMatchObject({ hooks: HOOK });
    expect(positionIssue(hooked!)).toBe(POSITION_ISSUE.hooked);
    expect(native).toMatchObject({ currency0: ZERO, symbol0: "USDC", symbol1: "VTA", liquidity: 8n });
    expect(plain).toMatchObject({ kind: "v4", managerName: "Uniswap v4", hooks: null, owed: false });
    expect(answer.notes[1]).toEqual({ manager: V4, name: "Uniswap v4", source: "explorer", complete: true });
  });

  it("falls back to the RPC's recent Transfer logs when the explorer is down, and says the list may be short", async () => {
    const getLogs: GetLogs = async () => [{ topics: [TRANSFER_TOPIC, pad(ZERO), pad(OWNER), pad("0x15" as Hex)] }];
    const answer = await loadPositions(deps({ [k(V3, "balanceOf", OWNER)]: 0n, ...v4Answers }, { fetchFn: explorer([], 503), getLogs }));
    expect(answer.positions.map((p) => p.tokenId)).toEqual(["21"]);
    expect(answer.notes[1]).toEqual({ manager: V4, name: "Uniswap v4", source: "recent", complete: false });
    expect(noteText(answer.notes[1]!)).toMatch(/explorer didn't answer.*type its id in Vault/);
  });

  it("merges the explorer and the logs, so a position the explorer hasn't indexed yet still shows", async () => {
    const getLogs: GetLogs = async () => [{ topics: [TRANSFER_TOPIC, pad(ZERO), pad(OWNER), pad("0x17" as Hex)] }];
    const answer = await loadPositions(deps({ [k(V3, "balanceOf", OWNER)]: 0n, ...v4Answers }, { fetchFn: explorer(["21", "22"]), getLogs }));
    expect(answer.positions.map((p) => p.tokenId)).toEqual(["23", "22", "21"]);
    expect(answer.notes[1]?.complete).toBe(true);
  });

  it("caps an enumerable list at MAX_POSITIONS and says so", async () => {
    const many: Record<string, Answer> = { [k(V3, "balanceOf", OWNER)]: BigInt(MAX_POSITIONS + 5), [k(V4, "balanceOf", OWNER)]: 0n };
    for (let i = 0; i < MAX_POSITIONS; i++) many[k(V3, "tokenOfOwnerByIndex", OWNER, i)] = BigInt(1000 + i);
    const answer = await loadPositions(deps(many));
    expect(answer.notes[0]).toEqual({ manager: V3, name: "Uniswap v3", source: "enumerable", complete: false });
    expect(noteText(answer.notes[0]!)).toBe(`Uniswap v3: showing the first ${MAX_POSITIONS} positions.`);
  });

  it("asks nothing more when the factory allows no candidate, and throws when the factory can't be read", async () => {
    expect(await loadPositions(deps({ [k(FACTORY, "managers", V3)]: [false, 0], [k(FACTORY, "managers", V4)]: [false, 1] }))).toEqual({
      managers: [],
      positions: [],
      notes: [],
    });
    await expect(loadPositions({ ...deps({}), read: async () => Promise.reject(new Error("rpc down")) })).rejects.toThrow("rpc down");
  });

  it("writes no note for a complete list", () => {
    expect(noteText({ manager: V4, name: "Uniswap v4", source: "explorer", complete: true })).toBeNull();
    expect(noteText({ manager: V4, name: "Uniswap v4", source: "explorer", complete: false })).toMatch(/may not be every position/);
  });
});

describe("readPosition: one position typed in", () => {
  const m = { ...CANDIDATES[1]!, kind: "v4" as const };

  it("reads the wallet's position, says when it is someone else's, and when there is none", async () => {
    const { read } = chain({
      [k(V4, "ownerOf", 21)]: OWNER,
      [k(V4, "getPoolAndPositionInfo", 21)]: v4Key(TA, TB),
      [k(V4, "getPositionLiquidity", 21)]: 7n,
      [k(V4, "ownerOf", 24)]: OTHER,
      [k(V4, "ownerOf", 99)]: new Error("NOT_MINTED"),
      [k(TA, "symbol")]: "VTA",
      [k(TB, "symbol")]: "VTB",
    });
    expect(await readPosition(read, m, 21n, OWNER)).toMatchObject({ tokenId: "21", symbol0: "VTA", symbol1: "VTB", liquidity: 7n });
    expect(await readPosition(read, m, 24n, OWNER)).toBe("not-yours");
    expect(await readPosition(read, m, 99n, OWNER)).toBeNull();
  });

  it("reads an all-zero pool (an id the manager never minted) as no position", async () => {
    const { read } = chain({ [k(V4, "ownerOf", 5)]: OWNER, [k(V4, "getPoolAndPositionInfo", 5)]: v4Key(ZERO, ZERO), [k(V4, "getPositionLiquidity", 5)]: 0n });
    expect(await readPosition(read, m, 5n, OWNER)).toBeNull();
  });
});
