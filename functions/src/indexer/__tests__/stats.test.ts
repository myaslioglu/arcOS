import { describe, expect, it } from "vitest";
import { toEventSelector, type Hex } from "viem";
import { ARCOS, PREVIOUS_MULTISENDS, feeControllerAbi, multisendAbi, tokenFactoryAbi } from "@arcos/chain";
import type { RawLog } from "../events";
import {
  STATS_EXCLUDED_WALLETS,
  STATS_TOPICS,
  dayOf,
  decodeStatsLog,
  decodeStatsLogs,
  docFieldsOf,
  emptyStatsState,
  foldStats,
  stateOfDoc,
  statsSources,
} from "../stats";
import { FACTORY, HOUSE, NEW_MULTISEND, OLD_MULTISEND, USDC, addr, drop, feeChanged, keyAdded, seedFees, timeOf, tokenCreated } from "./stats-logs";
import real from "./fixtures/mainnet-logs.json";
import counted from "./fixtures/mainnet-stats-logs.json";

const sources = statsSources("mainnet");
const window = (from: number, to: number) => ({ from, to });
const fold = (logs: RawLog[], from = 1, to = 10_000, state = emptyStatsState(), excluded: readonly string[] = STATS_EXCLUDED_WALLETS) =>
  foldStats(state, decodeStatsLogs(logs, sources, window(from, to)), excluded);

describe("statsSources", () => {
  it("reads TokenCreated, Drop of both Multisends, and KeyAdded and FeeChanged: four addresses on mainnet", () => {
    expect(sources.map((s) => [s.kind, s.address.toLowerCase()])).toEqual([
      ["tokenCreated", ARCOS.mainnet!.tokenFactory.toLowerCase()],
      ["drop", ARCOS.mainnet!.multisend.toLowerCase()],
      ["drop", PREVIOUS_MULTISENDS.mainnet[0]!.toLowerCase()],
      ["keyAdded", ARCOS.mainnet!.feeController.toLowerCase()],
      ["feeChanged", ARCOS.mainnet!.feeController.toLowerCase()],
    ]);
    expect(new Set(sources.map((s) => s.address)).size).toBe(4);
    expect(sources.map((s) => s.address.toLowerCase())).toContain("0x84593c14e52ee27e25dd5573f2d5ac652ad2480e");
    expect(sources.map((s) => s.address.toLowerCase())).toContain("0x03dde90fde3983ceee600dbc9b76f6d73512af47");
  });

  it("uses the topic0 of each event in the exported ABIs", () => {
    const of = (abi: readonly { type: string; name?: string }[], name: string) => toEventSelector(abi.find((i) => i.type === "event" && i.name === name) as never);
    expect(STATS_TOPICS).toEqual({
      tokenCreated: of(tokenFactoryAbi, "TokenCreated"),
      drop: of(multisendAbi, "Drop"),
      keyAdded: of(feeControllerAbi, "KeyAdded"),
      feeChanged: of(feeControllerAbi, "FeeChanged"),
    });
  });
});

describe("decodeStatsLog", () => {
  it("decodes TokenCreated with its creator and flags, lowercased", () => {
    const e = decodeStatsLog(tokenCreated({ block: 50, logIndex: 4 }, { creator: HOUSE, mintable: true, burnable: false }), sources);
    expect(e).toEqual({ kind: "tokenCreated", block: 50, logIndex: 4, timestamp: timeOf(50), creator: HOUSE.toLowerCase(), mintable: true, burnable: false });
  });

  it("decodes Drop from the new and from the old Multisend alike", () => {
    for (const address of [NEW_MULTISEND, OLD_MULTISEND]) {
      const e = decodeStatsLog(drop({ block: 60 }, { address, recipients: 5, failed: 2, token: addr(0xabc) }), sources);
      expect(e).toMatchObject({ kind: "drop", sender: addr(0xd00d), token: addr(0xabc), recipients: 5n, failedCount: 2n });
    }
  });

  it("decodes KeyAdded and FeeChanged by their key", () => {
    expect(decodeStatsLog(keyAdded({ block: 1 }, "MINT_FLAT", 7n), sources)).toMatchObject({ kind: "fee", value: 7n });
    expect(decodeStatsLog(feeChanged({ block: 2 }, "DROP_MIN", 9n), sources)).toMatchObject({ kind: "fee", value: 9n });
  });

  it("leaves a removed log, an unknown emitter, an unknown topic and a log that doesn't decode alone", () => {
    expect(decodeStatsLog({ ...tokenCreated({ block: 5 }), removed: true }, sources)).toBeNull();
    // A Drop-shaped log from an address Stats doesn't read (another Multisend).
    expect(decodeStatsLog({ ...drop({ block: 5 }), address: addr(0xbad) }, sources)).toBeNull();
    // A known emitter and an event it isn't read for: the FeeController's RecipientChanged.
    const other = { ...keyAdded({ block: 5 }, "MINT_FLAT", 1n), topics: ["0x" + "11".repeat(32)] as Hex[] };
    expect(decodeStatsLog(other, sources)).toBeNull();
    // Right emitter and topic, the data cut short.
    expect(decodeStatsLog({ ...drop({ block: 5 }), data: "0x1234" }, sources)).toBeNull();
    // A TokenCreated topic at the Multisend: each address is read for its own event only.
    expect(decodeStatsLog({ ...tokenCreated({ block: 5 }), address: NEW_MULTISEND }, sources)).toBeNull();
    // A Drop topic at the TokenFactory likewise.
    expect(decodeStatsLog({ ...drop({ block: 5 }), address: FACTORY }, sources)).toBeNull();
  });

  it("reads the emitter's address in any letter case", () => {
    expect(decodeStatsLog({ ...tokenCreated({ block: 5 }), address: FACTORY.toLowerCase() }, sources)).not.toBeNull();
    expect(decodeStatsLog({ ...tokenCreated({ block: 5 }), address: FACTORY.toUpperCase().replace("0X", "0x") }, sources)).not.toBeNull();
  });

  it("has no block time when the node sent none", () => {
    expect(decodeStatsLog(tokenCreated({ block: 5, timestamp: null }), sources)?.timestamp).toBeNull();
  });

  it("reads the real mainnet logs of the indexer's fixtures as nothing: they are other contracts' events", () => {
    for (const log of Object.values(real as Record<string, RawLog>)) expect(decodeStatsLog(log, sources), log.address).toBeNull();
  });
});

describe("decodeStatsLogs", () => {
  it("puts the events in chain order, whatever order the node sent them in", () => {
    const logs = [tokenCreated({ block: 30, logIndex: 1 }), tokenCreated({ block: 10, logIndex: 5 }), tokenCreated({ block: 30, logIndex: 0 }), drop({ block: 20 })];
    expect(decodeStatsLogs(logs, sources, window(1, 100)).map((e) => [e.block, e.logIndex])).toEqual([[10, 5], [20, 0], [30, 0], [30, 1]]);
  });

  it("counts a log once even if the node sent it twice", () => {
    const log = tokenCreated({ block: 10, logIndex: 2 });
    expect(decodeStatsLogs([log, log, { ...log }], sources, window(1, 100))).toHaveLength(1);
  });

  it("leaves out a log outside the window", () => {
    const logs = [tokenCreated({ block: 9 }), tokenCreated({ block: 10 }), tokenCreated({ block: 20 }), tokenCreated({ block: 21 })];
    expect(decodeStatsLogs(logs, sources, window(10, 20)).map((e) => e.block)).toEqual([10, 20]);
  });
});

describe("foldStats: Mint", () => {
  it("counts each TokenCreated once, by template, with the Mint fee as of then", () => {
    const logs = [
      ...seedFees(1),
      tokenCreated({ block: 10 }),
      tokenCreated({ block: 11 }, { mintable: true }),
      tokenCreated({ block: 12 }, { burnable: true }),
      tokenCreated({ block: 13 }, { mintable: true, burnable: true }),
      tokenCreated({ block: 14 }, { mintable: true, burnable: true }),
    ];
    const { state, delta } = fold(logs);
    expect(state.totals.tokensCreated).toBe(5);
    expect(state.totals.byTemplate).toEqual({ standard: 1, mintable: 1, burnable: 1, mintableBurnable: 2 });
    expect(state.totals.feesMint).toBe(5n * USDC);
    expect(delta).toEqual({ tokensCreated: 5, drops: 0, undated: 0 });
  });

  it("prices a Mint at the fee its log index finds: a change in the same block applies to what follows it", () => {
    const logs = [
      ...seedFees(1),
      tokenCreated({ block: 10, logIndex: 1 }),
      feeChanged({ block: 10, logIndex: 2 }, "MINT_FLAT", USDC / 2n),
      tokenCreated({ block: 10, logIndex: 3 }),
      // Sent out of order: the fold reads them in log order.
    ].reverse();
    expect(fold(logs).state.totals.feesMint).toBe(USDC + USDC / 2n);
  });

  it("prices a Mint at the fee in force across a window boundary: the fee is state", () => {
    const first = fold([...seedFees(1), feeChanged({ block: 5 }, "MINT_FLAT", 3n * USDC)], 1, 9);
    expect(first.state.fees.mintFlat).toBe(3n * USDC);
    const second = fold([tokenCreated({ block: 12 })], 10, 20, first.state);
    expect(second.state.totals.feesMint).toBe(3n * USDC);
  });

  it("prices a Mint before any fee is known at 0, never fails", () => {
    expect(fold([tokenCreated({ block: 3 })]).state.totals.feesMint).toBe(0n);
  });
});

describe("foldStats: Drop", () => {
  it("counts batches, native against token, rows submitted, delivered and failed", () => {
    const logs = [
      ...seedFees(1),
      drop({ block: 10 }, { recipients: 10, failed: 0 }),
      drop({ block: 11 }, { recipients: 4, failed: 1, token: addr(0xabc) }),
      drop({ block: 12 }, { recipients: 5, failed: 5, address: OLD_MULTISEND }),
    ];
    const { state, delta } = fold(logs);
    const t = state.totals;
    expect([t.drops, t.dropsNative, t.dropsToken]).toEqual([3, 2, 1]);
    expect([t.rowsSubmitted, t.rowsDelivered, t.rowsFailed]).toEqual([19, 13, 6]);
    expect(delta).toEqual({ tokensCreated: 0, drops: 3, undated: 0 });
  });

  it("counts Drop events of the old and the new Multisend together", () => {
    const { state } = fold([drop({ block: 10 }, { address: OLD_MULTISEND }), drop({ block: 11 }, { address: NEW_MULTISEND })]);
    expect(state.totals.drops).toBe(2);
  });

  it("prices a Drop at recipients times the per-recipient fee, and at the minimum when that is less", () => {
    // 0.01 a recipient, 2 at least: 10 rows = 0.1, so the minimum; 300 rows = 3.
    const { state } = fold([...seedFees(1), drop({ block: 10 }, { recipients: 10 }), drop({ block: 11 }, { recipients: 300 })]);
    expect(state.totals.feesDrop).toBe(2n * USDC + 3n * USDC);
  });

  it("prices a Drop at exactly the minimum when the quote equals it", () => {
    expect(fold([...seedFees(1), drop({ block: 10 }, { recipients: 200 })]).state.totals.feesDrop).toBe(2n * USDC);
  });

  it("charges the attempt, not the outcome: failed rows are in the fee", () => {
    expect(fold([...seedFees(1), drop({ block: 10 }, { recipients: 400, failed: 400 })]).state.totals.feesDrop).toBe(4n * USDC);
  });

  it("prices a Drop with the fee a change in an earlier block set", () => {
    const logs = [...seedFees(1), feeChanged({ block: 5 }, "DROP_PER_RECIPIENT", USDC / 50n), drop({ block: 10 }, { recipients: 500 })];
    expect(fold(logs).state.totals.feesDrop).toBe(10n * USDC);
  });

  it("never counts more failed rows than rows submitted", () => {
    const { state } = fold([drop({ block: 10 }, { recipients: 2, failed: 9 })]);
    expect([state.totals.rowsDelivered, state.totals.rowsFailed]).toEqual([0, 2]);
  });

  it("ignores fee events of keys Stats doesn't price with", () => {
    const logs = [keyAdded({ block: 1 }, "LOCK_FLAT", 5n), feeChanged({ block: 2 }, "PRO_MONTHLY", 7n)];
    expect(fold(logs).state.fees).toEqual({ mintFlat: null, dropPerRecipient: null, dropMin: null });
  });
});

describe("foldStats: the left-out wallet", () => {
  it("is the project wallet, as a constant", () => {
    expect(STATS_EXCLUDED_WALLETS.map((a) => a.toLowerCase())).toEqual(["0x463a81a017326e9029dcca2a2d9aa42599bef12c"]);
  });

  it("counts its Mints and Drops apart: in no total, no fee, no template, no day", () => {
    const logs = [
      ...seedFees(1),
      tokenCreated({ block: 10 }, { creator: HOUSE }),
      tokenCreated({ block: 11 }, { creator: HOUSE.toLowerCase() as typeof HOUSE, mintable: true }),
      tokenCreated({ block: 12 }),
      drop({ block: 13 }, { sender: HOUSE, recipients: 500, failed: 3 }),
      drop({ block: 14 }, { sender: HOUSE, address: OLD_MULTISEND }),
      drop({ block: 15 }, { recipients: 4 }),
    ];
    const { state, delta, days } = fold(logs);
    expect(state.excluded).toEqual({ tokensCreated: 2, drops: 2 });
    expect(state.totals.tokensCreated).toBe(1);
    expect(state.totals.byTemplate).toEqual({ standard: 1, mintable: 0, burnable: 0, mintableBurnable: 0 });
    expect(state.totals.feesMint).toBe(USDC);
    expect(state.totals.drops).toBe(1);
    expect([state.totals.rowsSubmitted, state.totals.rowsDelivered, state.totals.rowsFailed]).toEqual([4, 4, 0]);
    expect(state.totals.feesDrop).toBe(2n * USDC);
    expect(delta).toEqual({ tokensCreated: 1, drops: 1, undated: 0 });
    expect([...days.values()].reduce((n, d) => n + d.tokensCreated + d.drops, 0)).toBe(2);
  });

  it("is whatever list the step is given, compared without case", () => {
    const other = addr(0xface);
    const logs = [tokenCreated({ block: 10 }, { creator: other }), tokenCreated({ block: 11 }, { creator: HOUSE })];
    const { state } = fold(logs, 1, 10_000, emptyStatsState(), [other.toUpperCase().replace("0X", "0x")]);
    expect([state.totals.tokensCreated, state.excluded.tokensCreated]).toEqual([1, 1]);
  });
});

describe("foldStats: the state", () => {
  it("does not change the state it is given", () => {
    const before = emptyStatsState();
    const frozen = JSON.stringify(docFieldsOf(before));
    fold([...seedFees(1), tokenCreated({ block: 10 }), drop({ block: 11 })], 1, 10_000, before);
    expect(JSON.stringify(docFieldsOf(before))).toBe(frozen);
  });

  it("carries on from a state: two windows fold to what one window of both would", () => {
    const logs = [...seedFees(1), tokenCreated({ block: 10 }), drop({ block: 20 }, { recipients: 7, failed: 1 }), tokenCreated({ block: 30 }, { burnable: true })];
    const one = fold(logs, 1, 40).state;
    const a = fold(logs, 1, 15);
    const b = fold(logs, 16, 40, a.state);
    expect(docFieldsOf(b.state)).toEqual(docFieldsOf(one));
  });

  it("round-trips through the stored doc fields: amounts as decimal strings", () => {
    const { state } = fold([...seedFees(1), tokenCreated({ block: 10 }), drop({ block: 11 }, { recipients: 300 })]);
    const fields = docFieldsOf(state);
    expect(fields.fees).toEqual({ mintFlat: String(USDC), dropPerRecipient: String(USDC / 100n), dropMin: String(2n * USDC) });
    expect(fields.totals.feesDrop).toBe(String(3n * USDC));
    expect(stateOfDoc(fields)).toEqual(state);
  });
});

describe("foldStats: days", () => {
  it("buckets each event by the UTC day of its block time", () => {
    // Blocks at 2 a second: one day is 172,800 blocks.
    const d0 = 5_000;
    const d1 = d0 + 172_800;
    expect(dayOf(timeOf(d0))).toBe("2026-11-01");
    const logs = [tokenCreated({ block: d0 }), drop({ block: d0 + 1 }, { recipients: 6, failed: 2 }), drop({ block: d1 }, { recipients: 1 }), tokenCreated({ block: d1 + 1 })];
    const { days } = fold(logs, 1, d1 + 10);
    expect(Object.fromEntries(days)).toEqual({
      "2026-11-01": { tokensCreated: 1, drops: 1, rowsDelivered: 4 },
      "2026-11-02": { tokensCreated: 1, drops: 1, rowsDelivered: 1 },
    });
  });

  it("puts an event at the second before midnight in its own day and one at midnight in the next", () => {
    expect(dayOf(1_793_577_599)).toBe("2026-11-01");
    expect(dayOf(1_793_577_600)).toBe("2026-11-02");
  });

  it("counts an event with no block time in the totals and in no day", () => {
    const { state, days, delta } = fold([tokenCreated({ block: 5, timestamp: null }), drop({ block: 6, timestamp: null }), tokenCreated({ block: 7 })]);
    expect(delta.undated).toBe(2);
    expect(state.totals.tokensCreated).toBe(2);
    expect(days.size).toBe(1);
  });
});

describe("foldStats: ignored logs", () => {
  it("adds nothing for removed logs, unknown topics and other contracts", () => {
    const stranger: RawLog = { ...tokenCreated({ block: 5 }), address: addr(0x57a) };
    const unknownTopic: RawLog = { ...tokenCreated({ block: 6 }), topics: ["0x" + "22".repeat(32)] as Hex[] };
    const removed: RawLog = { ...drop({ block: 7 }), removed: true };
    const { state, delta } = fold([stranger, unknownTopic, removed]);
    expect(docFieldsOf(state)).toEqual(docFieldsOf(emptyStatsState()));
    expect(delta).toEqual({ tokensCreated: 0, drops: 0, undated: 0 });
  });
});

// Real logs, as rpc.mainnet.arc.io answered eth_getLogs on 2026-11-08 for the four contracts over the whole of their history
// (22,742,796 to 30,226,660): three KeyAdded (blocks 22,742,954 to 22,743,058), one FeeChanged (22,847,593, Mint's fee from
// 15 USDC to 1) and three TokenCreated, all by the project wallet. Neither Multisend has emitted anything yet: no Drop
// exists on mainnet, so the Drop cases above are encoded from the ABI.
describe("the real mainnet logs", () => {
  const LOGS = counted as unknown as (RawLog & { _event: string })[];
  const kind = (event: string) => LOGS.filter((l) => l._event === event);
  const ALL = { from: 22_742_796, to: 30_226_660 };

  it("are all read: three fee keys, one fee change, three tokens, in chain order", () => {
    expect(LOGS).toHaveLength(7);
    const events = decodeStatsLogs(LOGS, sources, ALL);
    expect(events.map((e) => e.kind)).toEqual(["fee", "fee", "fee", "fee", "tokenCreated", "tokenCreated", "tokenCreated"]);
    expect(events.map((e) => e.block)).toEqual([...events.map((e) => e.block)].sort((a, b) => a - b));
    expect(events.every((e) => e.timestamp !== null)).toBe(true);
    expect(kind("keyAdded")).toHaveLength(3);
  });

  it("seed the fees the FeeController was set up with, then Mint's fee change", () => {
    const keys = decodeStatsLogs(kind("keyAdded"), sources, ALL);
    const { state: seeded } = foldStats(emptyStatsState(), keys, []);
    expect(seeded.fees).toEqual({ mintFlat: 15n * USDC, dropPerRecipient: USDC / 20n, dropMin: 2n * USDC });
    const { state } = foldStats(seeded, decodeStatsLogs(kind("feeChanged"), sources, ALL), []);
    expect(state.fees).toEqual({ mintFlat: USDC, dropPerRecipient: USDC / 20n, dropMin: 2n * USDC });
  });

  it("count three tokens at the 1 USDC fee when no wallet is left out, and none when the project wallet is", () => {
    const events = decodeStatsLogs(LOGS, sources, ALL);
    const everyone = foldStats(emptyStatsState(), events, []);
    expect(everyone.state.totals).toMatchObject({ tokensCreated: 3, drops: 0, feesMint: 3n * USDC, feesDrop: 0n });
    expect(everyone.delta).toEqual({ tokensCreated: 3, drops: 0, undated: 0 });
    // Every token on mainnet so far was made by the project wallet.
    const standard = foldStats(emptyStatsState(), events);
    expect(standard.state.totals.tokensCreated).toBe(0);
    expect(standard.state.excluded).toEqual({ tokensCreated: 3, drops: 0 });
    expect(standard.days.size).toBe(0);
  });

  it("fold the same in two windows as in one", () => {
    const events = (w: { from: number; to: number }) => decodeStatsLogs(LOGS, sources, w);
    const one = foldStats(emptyStatsState(), events(ALL), []).state;
    const a = foldStats(emptyStatsState(), events({ from: 22_742_796, to: 24_000_000 }), []);
    const b = foldStats(a.state, events({ from: 24_000_001, to: 30_226_660 }), []);
    expect(docFieldsOf(b.state)).toEqual(docFieldsOf(one));
  });

  it("put the tokens on the UTC days of their block times", () => {
    const { days } = foldStats(emptyStatsState(), decodeStatsLogs(LOGS, sources, ALL), []);
    expect(Object.fromEntries(days)).toEqual({
      "2026-09-26": { tokensCreated: 1, drops: 0, rowsDelivered: 0 },
      "2026-10-05": { tokensCreated: 2, drops: 0, rowsDelivered: 0 },
    });
    expect([...days.values()].reduce((n, d) => n + d.tokensCreated, 0)).toBe(3);
  });
});
