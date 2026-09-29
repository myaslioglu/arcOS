import { describe, expect, it } from "vitest";
import type { Outcome } from "../commands";
import { answer, clear, emptyLog, note, submit, submitWithId } from "../log";

const out = (text: string): Outcome => ({ lines: [{ kind: "out", text }] });

describe("submit", () => {
  it("appends the typed line and a pending line, both tagged with a new id", () => {
    const { state, id, epoch } = submit(emptyLog(), "help");
    expect(id).toBe(1);
    expect(epoch).toBe(0);
    expect(state.lines).toEqual([
      { kind: "in", text: "help", id: 1 },
      { kind: "out", text: "…", id: 1 },
    ]);
  });

  it("sanitizes the typed line", () => {
    const { state } = submit(emptyLog(), "open \u202Efoo");
    expect(state.lines[0]).toEqual({ kind: "in", text: "open foo", id: 1 });
  });
});

describe("submitWithId", () => {
  it("appends the typed line and a pending line under the id the caller chose, not state.nextId", () => {
    const next = submitWithId(emptyLog(), 7, "help");
    expect(next.lines).toEqual([
      { kind: "in", text: "help", id: 7 },
      { kind: "out", text: "\u2026", id: 7 },
    ]);
    expect(next.nextId).toBe(8);
  });

  it("sanitizes the typed line", () => {
    const next = submitWithId(emptyLog(), 1, "open \u202Efoo");
    expect(next.lines[0]).toEqual({ kind: "in", text: "open foo", id: 1 });
  });

  it("never lowers nextId, even if called with an id below the current one", () => {
    const first = submitWithId(emptyLog(), 5, "a");
    const next = submitWithId(first, 2, "b");
    expect(next.nextId).toBe(6);
  });

  // The race Window.tsx:65-69 had: `run()` read `state` from its render closure, so two Enters typed
  // before a re-render both computed their line from the SAME stale state, and the non-functional
  // `setState(submitted)` let the second call's result silently overwrite the first's. The fix keeps
  // the next id in a ref (immune to a stale closure) and submits through a functional update
  // (`setState(s => submitWithId(s, id, typed))`), so each update folds onto whatever the latest state
  // actually is, however it was scheduled. This reproduces both patterns directly on log.ts's pure
  // functions, without needing to render Window.tsx.
  it("chains through a functional update: both commands survive even though both were computed from the same stale state", () => {
    const staleBase = emptyLog(); // what both `run()` calls saw, before either had re-rendered
    const id1 = 1;
    const id2 = 2; // a ref-sourced id: already advanced past id1 even though `state` hasn't caught up

    // The bug: setState(submitted) \u2014 non-functional \u2014 replaces the log with whichever literal value was
    // computed, so the second call's result (built from the same stale base) wipes out the first's.
    const firstResult = submitWithId(staleBase, id1, "first");
    const secondResultFromStaleBase = submitWithId(staleBase, id2, "second");
    const buggyFinal = secondResultFromStaleBase; // setState(buggyFinal) is all the DOM ever sees
    expect(buggyFinal.lines.some((l) => l.text === "first")).toBe(false); // the first command vanished

    // The fix: setState(prev => submitWithId(prev, id, typed)) \u2014 each update is handed whatever the
    // latest pending state is, so the second fold lands on top of the first instead of discarding it.
    const fixedFinal = submitWithId(firstResult, id2, "second");
    expect(fixedFinal.lines).toEqual([
      { kind: "in", text: "first", id: 1 },
      { kind: "out", text: "\u2026", id: 1 },
      { kind: "in", text: "second", id: 2 },
      { kind: "out", text: "\u2026", id: 2 },
    ]);
  });
});

describe("answer", () => {
  it("replaces its own pending line; out-of-order answers each land under their own command", () => {
    const first = submit(emptyLog(), "first");
    const second = submit(first.state, "second");
    const afterSecond = answer(second.state, second.id, second.epoch, out("second's answer"));
    const afterBoth = answer(afterSecond, first.id, first.epoch, out("first's answer"));
    expect(afterBoth.lines).toEqual([
      { kind: "in", text: "first", id: 1 },
      { kind: "out", text: "first's answer", id: 1 },
      { kind: "in", text: "second", id: 2 },
      { kind: "out", text: "second's answer", id: 2 },
    ]);
  });

  it("is dropped when it arrives after a clear", () => {
    const submitted = submit(emptyLog(), "balance");
    const cleared = clear(submitted.state);
    const resolved = answer(cleared, submitted.id, submitted.epoch, out("12.5 USDC"));
    expect(resolved).toEqual(cleared);
  });

  it("is dropped when its pending line already fell off the scrollback cap", () => {
    let state = emptyLog();
    let firstId = -1;
    let firstEpoch = -1;
    for (let i = 0; i < 201; i++) {
      const s = submit(state, `cmd-${i}`);
      if (i === 0) {
        firstId = s.id;
        firstEpoch = s.epoch;
      }
      state = s.state;
    }
    const resolved = answer(state, firstId, firstEpoch, out("late"));
    expect(resolved).toEqual(state);
  });

  it("gives every line of a multi-line answer the same id", () => {
    const submitted = submit(emptyLog(), "help");
    const resolved = answer(submitted.state, submitted.id, submitted.epoch, {
      lines: [
        { kind: "out", text: "one" },
        { kind: "out", text: "two" },
      ],
    });
    expect(resolved.lines).toEqual([
      { kind: "in", text: "help", id: 1 },
      { kind: "out", text: "one", id: 1 },
      { kind: "out", text: "two", id: 1 },
    ]);
  });
});

describe("clear", () => {
  it("empties the screen and bumps the epoch", () => {
    const submitted = submit(emptyLog(), "help");
    const cleared = clear(submitted.state);
    expect(cleared.lines).toEqual([]);
    expect(cleared.epoch).toBe(submitted.state.epoch + 1);
  });
});

describe("note", () => {
  it("appends a single already-resolved line", () => {
    const noted = note(emptyLog(), "finder   inspector   wallet");
    expect(noted.lines).toEqual([{ kind: "out", text: "finder   inspector   wallet", id: 1 }]);
  });
});

describe("the scrollback cap", () => {
  it("keeps at most 400 lines, dropping the oldest", () => {
    let state = emptyLog();
    for (let i = 0; i < 250; i++) {
      const s = submit(state, `cmd-${i}`);
      state = answer(s.state, s.id, s.epoch, out(`answer-${i}`));
    }
    expect(state.lines).toHaveLength(400);
    expect(state.lines[0]).toEqual({ kind: "in", text: "cmd-50", id: 51 });
    expect(state.lines.at(-1)).toEqual({ kind: "out", text: "answer-249", id: 250 });
  });
});
