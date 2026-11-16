import { describe, expect, it, vi } from "vitest";
import { getAddress, pad, type Address, type Hex } from "viem";
import { POSITION_MANAGERS } from "@arcos/chain";
import type { GetLogs } from "@/lib/positions";
import type { ContractRead, Read, ReadResult } from "@/lib/reads";
import {
  LOCKS_PAGE,
  OWNERSHIP_TRANSFER_STARTED,
  groupLocks,
  isEmpty,
  isUnlocked,
  loadLocks,
  lockDragItem,
  lockTitle,
  proofTokens,
  recentIncoming,
  roleOf,
  type Lock,
} from "../locks";

const FACTORY: Address = "0x2aA12f98795E7A65072950AfbA9d1E023D398241";
const W1: Address = getAddress("0x7e57000000000000000000000000000000000001");
const W2: Address = getAddress("0x7e57000000000000000000000000000000000002");
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const V3: Address = "0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377";
const TA: Address = "0xBFF22091be481B41C8CA49862653aBA216bAc041";
const TB: Address = "0xF4F40da2D2b7F0a2C5d2d3E113dDfBEB3FfDCa5E";
const PAIR: Address = "0xAdb5189625C0B1F634113A04B2d3D1635Dc429bc";
const at = (i: number) => getAddress(`0x${(0xa000 + i).toString(16).padStart(40, "0")}`);

type Answer = unknown | Error;
function chain(answers: Record<string, Answer>) {
  const keyOf = (c: ContractRead) => `${c.address}.${c.functionName}(${(c.args ?? []).map(String).join(",")})`.toLowerCase();
  const batches: string[][] = [];
  const read: Read = async (calls) => {
    batches.push(calls.map(keyOf));
    return calls.map((c): ReadResult => {
      const key = keyOf(c);
      if (!(key in answers)) return { status: "failure", error: new Error(`no answer for ${key}`) };
      const value = answers[key];
      return value instanceof Error ? { status: "failure", error: value } : { status: "success", result: value };
    });
  };
  return { read, batches };
}
const k = (address: string, fn: string, ...args: unknown[]) => `${address}.${fn}(${args.map(String).join(",")})`.toLowerCase();

/** A token vault's answers. */
const tokenVault = (vault: Address, owner: Address, token: Address, amount: bigint, extra: Record<string, Answer> = {}) => ({
  [k(vault, "owner")]: owner,
  [k(vault, "pendingOwner")]: ZERO,
  [k(vault, "unlockAt")]: 2_000_000_000n,
  [k(vault, "token")]: token,
  [k(vault, "lockedAmount")]: amount,
  ...extra,
});
/** A position vault's answers. */
const positionVault = (vault: Address, owner: Address, tokenId: bigint, holder: Address, extra: Record<string, Answer> = {}) => ({
  [k(vault, "owner")]: owner,
  [k(vault, "pendingOwner")]: ZERO,
  [k(vault, "unlockAt")]: 2_000_000_000n,
  [k(vault, "manager")]: V3,
  [k(vault, "tokenId")]: tokenId,
  [k(vault, "kind")]: 0,
  [k(vault, "feeShareBps")]: 200,
  [k(vault, "currencies")]: [TA, TB],
  [k(vault, "liquidity")]: 5n,
  [k(V3, "ownerOf", tokenId)]: holder,
  ...extra,
});
const symbols = { [k(TA, "symbol")]: "VTB", [k(TA, "decimals")]: 18, [k(TB, "symbol")]: "VTA", [k(TB, "decimals")]: 6 };
const deps = (answers: Record<string, Answer>, over: Partial<Parameters<typeof loadLocks>[0]> = {}) => ({
  ...chain(answers),
  factory: FACTORY,
  wallet: W1,
  extra: [],
  pages: 1,
  managers: POSITION_MANAGERS.mainnet,
  ...over,
});

describe("loadLocks", () => {
  it("reads the registry's newest page, and each vault's own state: a token lock and a position lock", async () => {
    const answers = {
      [k(FACTORY, "vaultsOfLength", W1)]: 2n,
      [k(FACTORY, "vaultsOfSlice", W1, 0, 2)]: [at(1), at(2)],
      ...tokenVault(at(1), W1, TA, 10n ** 21n),
      ...positionVault(at(2), W1, 59605n, at(2)),
      ...symbols,
      [k(TA, "decimals")]: 18,
    };
    const answer = await loadLocks(deps(answers));
    expect(answer.registered).toBe(2);
    expect(answer.readFromRegistry).toBe(2);
    expect(answer.locks.map((l) => l.vault)).toEqual([at(2), at(1)]); // newest first
    const [position, token] = answer.locks as [Lock, Lock];
    expect(token).toEqual({
      vault: at(1),
      owner: W1,
      pendingOwner: null,
      unlockAt: 2_000_000_000,
      kind: "token",
      token: TA,
      symbol: "VTB",
      decimals: 18,
      amount: 10n ** 21n,
      pair: null,
    });
    expect(position).toMatchObject({
      kind: "position",
      manager: V3,
      managerName: "Uniswap v3",
      positionKind: "v3",
      tokenId: "59605",
      feeShareBps: 200,
      currency0: TA,
      currency1: TB,
      symbol0: "VTB",
      symbol1: "VTA",
      decimals0: 18,
      decimals1: 6,
      liquidity: 5n,
      withdrawn: false,
    });
  });

  it("reads LOCKS_PAGE entries per page asked for, from the end of the registry", async () => {
    const total = LOCKS_PAGE * 2 + 3;
    const d = deps({ [k(FACTORY, "vaultsOfLength", W1)]: BigInt(total), [k(FACTORY, "vaultsOfSlice", W1, total - LOCKS_PAGE, LOCKS_PAGE)]: [] });
    await loadLocks(d);
    expect(d.batches[1]).toEqual([k(FACTORY, "vaultsOfSlice", W1, total - LOCKS_PAGE, LOCKS_PAGE)]);
    const two = deps({ [k(FACTORY, "vaultsOfLength", W1)]: BigInt(total), [k(FACTORY, "vaultsOfSlice", W1, 3, LOCKS_PAGE * 2)]: [] }, { pages: 2 });
    await loadLocks(two);
    expect(two.batches[1]).toEqual([k(FACTORY, "vaultsOfSlice", W1, 3, LOCKS_PAGE * 2)]);
  });

  it("adds a remembered or opened vault only once the factory's isVault says it is one, and names the others", async () => {
    const answers = {
      [k(FACTORY, "vaultsOfLength", W1)]: 0n,
      [k(FACTORY, "isVault", at(7))]: true,
      [k(FACTORY, "isVault", at(8))]: false,
      ...tokenVault(at(7), W1, TA, 1n),
      ...tokenVault(at(8), W1, TA, 1n),
      ...symbols,
    };
    const answer = await loadLocks(deps(answers, { extra: [at(7), at(8), at(7)] }));
    expect(answer.locks.map((l) => l.vault)).toEqual([at(7)]);
    expect(answer.notVaults).toEqual([at(8)]);
  });

  it("finds a handover to the wallet from the recent logs, and checks it like any other", async () => {
    const getLogs = vi.fn<GetLogs>(async () => [{ address: at(9), topics: [OWNERSHIP_TRANSFER_STARTED, pad(W2), pad(W1)] }]);
    const answers = {
      [k(FACTORY, "vaultsOfLength", W1)]: 0n,
      [k(FACTORY, "isVault", at(9))]: true,
      ...tokenVault(at(9), W2, TA, 3n, { [k(at(9), "pendingOwner")]: W1 }),
      ...symbols,
    };
    const answer = await loadLocks(deps(answers, { getLogs, getBlockNumber: async () => 50_000n }));
    expect(answer.locks).toHaveLength(1);
    expect(roleOf(answer.locks[0]!, W1)).toBe("incoming");
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ topics: [OWNERSHIP_TRANSFER_STARTED, null, pad(W1.toLowerCase() as Hex, { size: 32 })] });
    expect(getLogs.mock.calls[0]?.[0].address).toBeUndefined();
  });

  it("keeps the list when the recent logs can't be read", async () => {
    const answer = await loadLocks(deps({ [k(FACTORY, "vaultsOfLength", W1)]: 0n }, { getLogs: async () => Promise.reject(new Error("range")), getBlockNumber: async () => 1n }));
    expect(answer.locks).toEqual([]);
  });

  it("names an LP token's pair, and its two tokens are the lock's proof pages", async () => {
    const answers = {
      [k(FACTORY, "vaultsOfLength", W1)]: 1n,
      [k(FACTORY, "vaultsOfSlice", W1, 0, 1)]: [at(3)],
      ...tokenVault(at(3), W1, PAIR, 9n, {
        [k(PAIR, "symbol")]: "UNI-V2",
        [k(PAIR, "decimals")]: 18,
        [k(PAIR, "token0")]: TA,
        [k(PAIR, "token1")]: TB,
        [k(PAIR, "getReserves")]: [1n, 2n, 3],
      }),
      ...symbols,
    };
    const [lp] = (await loadLocks(deps(answers))).locks;
    expect(lp).toMatchObject({ kind: "token", symbol: "UNI-V2", pair: { token0: TA, token1: TB, symbol0: "VTB", symbol1: "VTA" } });
    expect(proofTokens(lp!)).toEqual([TA, TB]);
  });

  it("marks a position vault whose position has left as withdrawn, and an emptied token vault as empty", async () => {
    const answers = {
      [k(FACTORY, "vaultsOfLength", W1)]: 2n,
      [k(FACTORY, "vaultsOfSlice", W1, 0, 2)]: [at(4), at(5)],
      ...positionVault(at(4), W1, 1n, W1),
      ...tokenVault(at(5), W1, TA, 0n),
      ...symbols,
    };
    const locks = (await loadLocks(deps(answers))).locks;
    expect(locks.map((l) => isEmpty(l))).toEqual([true, true]);
    expect(groupLocks(locks, W1).empty).toHaveLength(2);
  });

  it("leaves out a vault whose state can't be read, and lets one hostile token cost its lock's symbol only", async () => {
    const answers = {
      [k(FACTORY, "vaultsOfLength", W1)]: 2n,
      [k(FACTORY, "vaultsOfSlice", W1, 0, 2)]: [at(5), at(6)],
      ...tokenVault(at(5), W1, TA, 1n),
      [k(at(6), "owner")]: new Error("not a vault"),
      ...symbols,
    };
    const hostile = chain(answers);
    // TA's reads burn the whole batch's gas: every batch holding one of them throws.
    const read: Read = async (calls) => {
      if (calls.length > 1 && calls.some((c) => c.address.toLowerCase() === TA.toLowerCase() && c.functionName !== "symbol")) throw new Error("out of gas");
      return hostile.read(calls);
    };
    const answer = await loadLocks(deps(answers, { read }));
    expect(answer.locks.map((l) => l.vault)).toEqual([at(5)]);
    expect(answer.locks[0]).toMatchObject({ symbol: "VTB", amount: 1n });
  });

  it("throws when the factory's registry can't be read", async () => {
    await expect(loadLocks(deps({}))).rejects.toThrow("registry");
  });
});

describe("roles, groups and the rest", () => {
  const lock = (over: Partial<Lock> = {}) =>
    ({ vault: at(1), owner: W1, pendingOwner: null, unlockAt: 100, kind: "token", token: TA, symbol: "VTB", decimals: 18, amount: 10n ** 21n, pair: null, ...over }) as Lock;

  it("tells the owner, the wallet a vault is being handed to, and everyone else apart", () => {
    expect(roleOf(lock(), W1.toLowerCase())).toBe("owner");
    expect(roleOf(lock({ owner: W2, pendingOwner: W1 }), W1)).toBe("incoming");
    expect(roleOf(lock({ owner: W2 }), W1)).toBe("other");
    // The owner who started a handover is still the owner until it is accepted.
    expect(roleOf(lock({ pendingOwner: W2 }), W1)).toBe("owner");
  });

  it("groups transfers waiting for the wallet, its locks, its emptied vaults and the rest", () => {
    const groups = groupLocks([lock(), lock({ vault: at(2), owner: W2, pendingOwner: W1 }), lock({ vault: at(3), amount: 0n }), lock({ vault: at(4), owner: W2 })], W1);
    expect(Object.fromEntries(Object.entries(groups).map(([g, l]) => [g, l.map((x) => x.vault)]))).toEqual({
      incoming: [at(2)],
      owner: [at(1)],
      empty: [at(3)],
      other: [at(4)],
    });
  });

  it("unlocks at unlockAt itself, as withdraw checks `block.timestamp < unlockAt`", () => {
    expect(isUnlocked(lock(), 99)).toBe(false);
    expect(isUnlocked(lock(), 100)).toBe(true);
  });

  it("titles, drags and links each kind", () => {
    const amount = (u: bigint, d: number) => `${u / 10n ** BigInt(d)}`;
    expect(lockTitle(lock(), amount)).toBe("1000 VTB");
    expect(lockTitle(lock({ amount: null }), amount)).toBe("VTB");
    const position = { ...lock(), kind: "position", manager: V3, managerName: "Uniswap v3", tokenId: "7", currency0: ZERO, currency1: TB } as unknown as Lock;
    expect(lockTitle(position, amount)).toBe("Uniswap v3 #7");
    expect(proofTokens(position)).toEqual([TB]);
    expect(proofTokens(lock())).toEqual([TA]);
    expect(lockDragItem(lock())).toEqual({ kind: "lock", address: at(1) });
  });

  it("reads OwnershipTransferStarted logs as the vaults that emitted them", async () => {
    const getLogs: GetLogs = async () => [
      { address: at(1), topics: [] },
      { address: at(1).toLowerCase(), topics: [] },
      { address: "junk", topics: [] },
      { topics: [] },
    ];
    expect(await recentIncoming(getLogs, 10n, W1)).toEqual([at(1)]);
  });
});
