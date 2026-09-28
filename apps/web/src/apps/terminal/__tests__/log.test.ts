import { describe, expect, it } from "vitest";
import type { Outcome } from "../commands";
import { answer, clear, emptyLog, note, submit } from "../log";

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
