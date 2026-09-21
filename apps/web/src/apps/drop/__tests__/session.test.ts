import { afterEach, describe, expect, it } from "vitest";
import type { DropResult } from "../runDrop";
import type { ExcludedRow } from "../result";
import { dropSessionReducer, initialDropSessionState, session, type DropSessionState } from "../session";

const emptyResult: DropResult = { delivered: [], failed: [], remaining: [], unconfirmed: [], hashes: [], stoppedBecause: null, message: null };

const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;

/** A result as `runDrop` leaves it after a batch came back unconfirmed — `unconfirmed` carries the
 * rows, `hashes`' last entry is that batch's hash (see result.ts's `unconfirmedHash`). */
const unconfirmedResult = (rows: DropResult["unconfirmed"], hashes: string[] = ["0xhash"]): DropResult => ({
  ...emptyResult,
  unconfirmed: rows,
  hashes,
  stoppedBecause: "unconfirmed",
  message: "Batch 1 of 2 was sent but is unconfirmed — check the explorer before sending the rest.",
});

const excludedRow = (line: number, text: string, reason: string): ExcludedRow => ({ line, text, reason });

const sendingState = (over: Partial<DropSessionState> = {}): DropSessionState => ({
  status: "sending",
  tokenLabel: "USDC",
  token: null,
  decimals: 6,
  progress: null,
  result: null,
  remainingText: "0x1111111111111111111111111111111111111111,1",
  excludedRows: [],
  startedAt: 1,
  ...over,
});

const doneState = (over: Partial<DropSessionState> = {}): DropSessionState => ({
  ...sendingState(),
  status: "done",
  progress: null,
  result: emptyResult,
  remainingText: "",
  ...over,
});

describe("dropSessionReducer", () => {
  describe("start", () => {
    it("starts a session from idle", () => {
      const next = dropSessionReducer(initialDropSessionState, {
        type: "start",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        text: "0x1111111111111111111111111111111111111111,1",
        excludedRows: [],
        startedAt: 10,
      });
      expect(next).toEqual({
        status: "sending",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        progress: null,
        result: null,
        remainingText: "0x1111111111111111111111111111111111111111,1",
        excludedRows: [],
        startedAt: 10,
      });
    });

    it("carries the parser-excluded rows — original text and reason, not just the line number — into the session, unchanged through to done", () => {
      const rows = [excludedRow(4, "not-an-address, 1", "Not an address"), excludedRow(9, "0x1,0", "Amount is zero"), excludedRow(17, "", "Expected an address and an amount")];
      const started = dropSessionReducer(initialDropSessionState, {
        type: "start",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        text: "x",
        excludedRows: rows,
        startedAt: 10,
      });
      expect(started.excludedRows).toEqual(rows);
      const finished = dropSessionReducer(started, { type: "finish", result: emptyResult, remainingText: "" });
      expect(finished.excludedRows).toEqual(rows);
    });

    it("starts a session from done (reviewing one result, then sending the remainder)", () => {
      const next = dropSessionReducer(doneState(), {
        type: "start",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        text: "x",
        excludedRows: [],
        startedAt: 20,
      });
      expect(next.status).toBe("sending");
      expect(next.startedAt).toBe(20);
    });

    it("refuses to start while already sending — the hard guard against a second concurrent send", () => {
      const state = sendingState();
      const next = dropSessionReducer(state, {
        type: "start",
        tokenLabel: "USDC",
        token: null,
        decimals: 6,
        text: "a second list",
        excludedRows: [],
        startedAt: 99,
      });
      expect(next).toBe(state); // unchanged reference: the no-op IS the refusal
    });
  });

  describe("progress", () => {
    it("applies while sending", () => {
      const next = dropSessionReducer(sendingState(), { type: "progress", progress: { batch: 1, batches: 3, step: "send" } });
      expect(next.progress).toEqual({ batch: 1, batches: 3, step: "send" });
    });

    it("is a no-op outside sending", () => {
      expect(dropSessionReducer(initialDropSessionState, { type: "progress", progress: { batch: 1, batches: 1, step: "send" } })).toBe(
        initialDropSessionState,
      );
      const done = doneState();
      expect(dropSessionReducer(done, { type: "progress", progress: { batch: 1, batches: 1, step: "send" } })).toBe(done);
    });
  });

  describe("finish", () => {
    it("only applies from sending, moving to done and clearing progress", () => {
      const state = sendingState({ progress: { batch: 2, batches: 3, step: "send" } });
      const next = dropSessionReducer(state, { type: "finish", result: emptyResult, remainingText: "leftover" });
      expect(next.status).toBe("done");
      expect(next.progress).toBeNull();
      expect(next.result).toBe(emptyResult);
      expect(next.remainingText).toBe("leftover");
    });

    it("is a no-op outside sending", () => {
      expect(dropSessionReducer(initialDropSessionState, { type: "finish", result: emptyResult, remainingText: "" })).toBe(initialDropSessionState);
      const done = doneState();
      expect(dropSessionReducer(done, { type: "finish", result: emptyResult, remainingText: "" })).toBe(done);
    });
  });

  describe("dismiss", () => {
    it("only applies from done, resetting to the initial state", () => {
      const next = dropSessionReducer(doneState({ remainingText: "leftover" }), { type: "dismiss" });
      expect(next).toEqual(initialDropSessionState);
    });

    it("is a no-op outside done", () => {
      expect(dropSessionReducer(initialDropSessionState, { type: "dismiss" })).toBe(initialDropSessionState);
      const state = sendingState();
      expect(dropSessionReducer(state, { type: "dismiss" })).toBe(state);
    });
  });

  // G1 (wave H): an unconfirmed batch's rows live ONLY in `result.unconfirmed` — never in
  // `remaining`, never in the textarea. Anything that clears the result therefore destroys them,
  // and with them the hash the user needs to find out whether that batch landed. Both ways out of
  // a result are refused until one of the two buttons has resolved it.
  describe("a result with an unresolved unconfirmed batch", () => {
    const rows = [{ line: 1, address: A, amount: 1_000_000n }];
    const stuck = () => doneState({ result: unconfirmedResult(rows), remainingText: `${B},2` });
    const startAction = {
      type: "start" as const, tokenLabel: "USDC", token: null, decimals: 6, text: `${B},2`, excludedRows: [], startedAt: 20,
    };

    it("refuses to start the next send over it", () => {
      const state = stuck();
      expect(dropSessionReducer(state, startAction)).toBe(state);
    });

    it("refuses to be dismissed", () => {
      const state = stuck();
      expect(dropSessionReducer(state, { type: "dismiss" })).toBe(state);
    });

    it("allows both again once the batch is confirmed landed", () => {
      const resolved = dropSessionReducer(stuck(), { type: "dismissUnconfirmed" });
      expect(dropSessionReducer(resolved, startAction).status).toBe("sending");
      expect(dropSessionReducer(resolved, { type: "dismiss" })).toEqual(initialDropSessionState);
    });

    it("allows both again once the rows are back in the list", () => {
      const resolved = dropSessionReducer(stuck(), { type: "recoverUnconfirmed" });
      expect(dropSessionReducer(resolved, startAction).status).toBe("sending");
      expect(dropSessionReducer(resolved, { type: "dismiss" })).toEqual(initialDropSessionState);
    });

    it("counts put-back rows as remaining, so the banner above the list stops undercounting", () => {
      const state = doneState({ result: { ...unconfirmedResult(rows), remaining: [{ line: 2, address: B, amount: 2_000_000n }] } });
      const next = dropSessionReducer(state, { type: "recoverUnconfirmed" });
      expect(next.result?.remaining).toEqual([{ line: 2, address: B, amount: 2_000_000n }, ...rows]);
      expect(next.result?.unconfirmed).toEqual([]);
      // Idempotent: the second call is a no-op, so the rows can't be counted twice.
      expect(dropSessionReducer(next, { type: "recoverUnconfirmed" })).toBe(next);
    });
  });

  // N1: an unconfirmed batch's rows must be visible AND recoverable — "It landed — I checked" just
  // clears the section; "It didn't land — put these rows back" is the only way they re-enter the
  // send list, and it must be a deliberate click that never duplicates rows if triggered twice.
  describe("dismissUnconfirmed ('It landed — I checked')", () => {
    it("clears result.unconfirmed, from done, without touching remainingText", () => {
      const rows = [{ line: 3, address: A, amount: 1n }];
      const state = doneState({ result: unconfirmedResult(rows), remainingText: "leftover" });
      const next = dropSessionReducer(state, { type: "dismissUnconfirmed" });
      expect(next.result?.unconfirmed).toEqual([]);
      expect(next.remainingText).toBe("leftover");
      // The rest of the result is untouched — this only clears the unconfirmed section.
      expect(next.result?.stoppedBecause).toBe("unconfirmed");
      expect(next.result?.hashes).toEqual(["0xhash"]);
    });

    it("is a no-op once there's nothing unconfirmed left to dismiss", () => {
      const state = doneState({ result: emptyResult });
      expect(dropSessionReducer(state, { type: "dismissUnconfirmed" })).toBe(state);
    });

    it("is idempotent — dismissing twice doesn't error or change anything the second time", () => {
      const rows = [{ line: 3, address: A, amount: 1n }];
      const once = dropSessionReducer(doneState({ result: unconfirmedResult(rows) }), { type: "dismissUnconfirmed" });
      const twice = dropSessionReducer(once, { type: "dismissUnconfirmed" });
      expect(twice).toBe(once);
    });

    it("is a no-op outside done", () => {
      expect(dropSessionReducer(initialDropSessionState, { type: "dismissUnconfirmed" })).toBe(initialDropSessionState);
      const state = sendingState();
      expect(dropSessionReducer(state, { type: "dismissUnconfirmed" })).toBe(state);
    });
  });

  describe("recoverUnconfirmed (\"It didn't land — put these rows back\")", () => {
    it("moves unconfirmed rows into remainingText, formatted the same way the rest of the list is, and clears unconfirmed", () => {
      // 1_000_000n at 6 decimals (native units) formats back to "1" — see parse.ts's formatDropList.
      const rows = [{ line: 5, address: A, amount: 1_000_000n }];
      const state = doneState({ result: unconfirmedResult(rows), remainingText: `${B},2`, token: null, decimals: 6 });
      const next = dropSessionReducer(state, { type: "recoverUnconfirmed" });
      expect(next.result?.unconfirmed).toEqual([]);
      expect(next.remainingText).toBe(`${B},2\n${A},1`);
    });

    it("starts remainingText fresh — no leading blank line — when nothing else was remaining", () => {
      const rows = [{ line: 1, address: A, amount: 1_000_000n }];
      const state = doneState({ result: unconfirmedResult(rows), remainingText: "", token: null, decimals: 6 });
      const next = dropSessionReducer(state, { type: "recoverUnconfirmed" });
      expect(next.remainingText).toBe(`${A},1`);
    });

    it("formats a real token's rows at the token's own decimals, not native's", () => {
      const rows = [{ line: 1, address: A, amount: 5n * 10n ** 9n }]; // 5 at 9 decimals
      const state = doneState({ result: unconfirmedResult(rows), remainingText: "", token: B, decimals: 9 });
      const next = dropSessionReducer(state, { type: "recoverUnconfirmed" });
      expect(next.remainingText).toBe(`${A},5`);
    });

    it("moves rows exactly once — calling it again (rows already moved) doesn't duplicate them", () => {
      const rows = [{ line: 5, address: A, amount: 1_000_000n }];
      const state = doneState({ result: unconfirmedResult(rows), remainingText: "", token: null, decimals: 6 });
      const once = dropSessionReducer(state, { type: "recoverUnconfirmed" });
      const twice = dropSessionReducer(once, { type: "recoverUnconfirmed" });
      expect(twice).toBe(once); // no-op reference equality — nothing changed, nothing duplicated
      expect(twice.remainingText).toBe(`${A},1`);
    });

    it("is a no-op once there's nothing unconfirmed left to recover (e.g. after dismissUnconfirmed)", () => {
      const rows = [{ line: 5, address: A, amount: 1_000_000n }];
      const dismissed = dropSessionReducer(doneState({ result: unconfirmedResult(rows) }), { type: "dismissUnconfirmed" });
      const next = dropSessionReducer(dismissed, { type: "recoverUnconfirmed" });
      expect(next).toBe(dismissed);
    });

    it("is a no-op outside done", () => {
      expect(dropSessionReducer(initialDropSessionState, { type: "recoverUnconfirmed" })).toBe(initialDropSessionState);
      const state = sendingState();
      expect(dropSessionReducer(state, { type: "recoverUnconfirmed" })).toBe(state);
    });
  });
});

describe("session store", () => {
  // The store is a module-level singleton shared across every test in this file — always leave it idle
  // afterward regardless of what a test did, so tests never leak into each other.
  afterEach(() => {
    if (session.getSnapshot().status === "sending") session.finish(emptyResult, "");
    if (session.getSnapshot().status === "done") session.dismiss();
  });

  it("start() returns true and the snapshot reflects it", () => {
    expect(session.getSnapshot().status).toBe("idle");
    const started = session.start("USDC", null, 6, "0x1111111111111111111111111111111111111111,1");
    expect(started).toBe(true);
    expect(session.getSnapshot().status).toBe("sending");
  });

  it("start() refuses a second concurrent send — the hard guard against any number of windows or clicks", () => {
    expect(session.start("USDC", null, 6, "list one")).toBe(true);
    expect(session.start("USDC", null, 6, "list two")).toBe(false);
    // The second, refused call changed nothing: the session still reflects the first list.
    expect(session.getSnapshot().remainingText).toBe("list one");
  });

  it("start() defaults excludedRows to an empty array when the caller omits it", () => {
    session.start("USDC", null, 6, "x");
    expect(session.getSnapshot().excludedRows).toEqual([]);
  });

  it("start() records the excluded rows — original text and reason — the caller passes", () => {
    const rows = [excludedRow(2, "bad,row", "Not an address"), excludedRow(5, "0x1,0", "Amount is zero")];
    session.start("USDC", null, 6, "x", rows);
    expect(session.getSnapshot().excludedRows).toEqual(rows);
  });

  it("setProgress() only takes effect once a session is sending", () => {
    session.setProgress({ batch: 1, batches: 1, step: "send" }); // no session yet — no-op
    expect(session.getSnapshot().progress).toBeNull();

    session.start("USDC", null, 6, "x");
    session.setProgress({ batch: 1, batches: 2, step: "send" });
    expect(session.getSnapshot().progress).toEqual({ batch: 1, batches: 2, step: "send" });
  });

  it("finish() only takes effect once a session is sending", () => {
    session.finish(emptyResult, ""); // no session yet — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("USDC", null, 6, "x");
    session.finish(emptyResult, "leftover");
    expect(session.getSnapshot()).toMatchObject({ status: "done", result: emptyResult, remainingText: "leftover" });
  });

  it("dismiss() only takes effect once a session is done, returning to idle", () => {
    session.dismiss(); // idle already — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("USDC", null, 6, "x");
    session.dismiss(); // still sending — no-op
    expect(session.getSnapshot().status).toBe("sending");

    session.finish(emptyResult, "");
    session.dismiss();
    expect(session.getSnapshot()).toEqual(initialDropSessionState);
  });

  it("subscribe() notifies listeners on a change and not on a refused start", () => {
    let calls = 0;
    const unsubscribe = session.subscribe(() => calls++);
    session.start("USDC", null, 6, "x"); // change
    const callsAfterStart = calls;
    session.start("USDC", null, 6, "y"); // refused, no change
    expect(calls).toBe(callsAfterStart);
    unsubscribe();
  });

  it("dismissUnconfirmed() only takes effect once a session is done with an unconfirmed batch to clear", () => {
    session.dismissUnconfirmed(); // idle — no-op
    expect(session.getSnapshot().status).toBe("idle");

    session.start("USDC", null, 6, "x");
    session.finish(unconfirmedResult([{ line: 1, address: A, amount: 1n }]), "");
    session.dismissUnconfirmed();
    expect(session.getSnapshot().result?.unconfirmed).toEqual([]);
  });

  it("recoverUnconfirmed() moves the unconfirmed rows into remainingText and survives a reopened window's initial read", () => {
    session.start("USDC", null, 6, "x");
    session.finish(unconfirmedResult([{ line: 1, address: A, amount: 1_000_000n }]), "");
    session.recoverUnconfirmed();
    expect(session.getSnapshot().result?.unconfirmed).toEqual([]);
    expect(session.getSnapshot().remainingText).toBe(`${A},1`);
    // A freshly "reopened window" just reads getSnapshot() again — the recovered row is there.
    expect(session.getSnapshot().remainingText).toContain(A);
  });
});
