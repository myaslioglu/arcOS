import { sanitize, type Line, type Outcome } from "./commands";

/**
 * One rendered line of the scrollback. Lines from the same submitted command share an `id`: a
 * still-pending command's line reads "…" until its own `answer` replaces it, in place, wherever it
 * currently sits — so an answer always lands under its own command, whatever order commands finish
 * in.
 */
export type LogLine = Line & { id: number };

export type LogState = {
  lines: readonly LogLine[];
  /** Bumped by `clear`. An `answer` captured under an earlier epoch is dropped, never shown. */
  epoch: number;
  nextId: number;
};

/** The scrollback keeps this many lines; older ones fall off the top. */
const MAX_LINES = 400;

const cap = (lines: readonly LogLine[]): LogLine[] =>
  lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : [...lines];

export function emptyLog(): LogState {
  return { lines: [], epoch: 0, nextId: 1 };
}

/**
 * Appends the typed line (sanitized) and a pending "…" placeholder, both tagged with a new id.
 * Returns the new state, the id and the epoch it was submitted under — both needed by `answer`.
 */
export function submit(state: LogState, typed: string): { state: LogState; id: number; epoch: number } {
  const id = state.nextId;
  const lines = cap([...state.lines, { kind: "in", text: sanitize(typed), id }, { kind: "out", text: "…", id }]);
  return { state: { ...state, lines, nextId: id + 1 }, id, epoch: state.epoch };
}

/**
 * Replaces `id`'s pending line with its answer, in place. Dropped silently (state unchanged) when
 * `epoch` no longer matches the current one — a `clear` ran after `submit` — or the pending line
 * already fell off the scrollback cap.
 */
export function answer(state: LogState, id: number, epoch: number, outcome: Outcome): LogState {
  if (epoch !== state.epoch) return state;
  const at = state.lines.findIndex((l) => l.id === id && l.kind === "out" && l.text === "…");
  if (at === -1) return state;
  const resolved = outcome.lines.map((l) => ({ ...l, id }));
  return { ...state, lines: cap([...state.lines.slice(0, at), ...resolved, ...state.lines.slice(at + 1)]) };
}

/** Empties the screen and bumps the epoch, so every answer still in flight is dropped on arrival. */
export function clear(state: LogState): LogState {
  return { lines: [], epoch: state.epoch + 1, nextId: state.nextId };
}

/**
 * Appends a single already-resolved line that isn't a command's answer — Tab's list of more than one
 * completion, for example.
 */
export function note(state: LogState, text: string): LogState {
  const id = state.nextId;
  return { ...state, lines: cap([...state.lines, { kind: "out", text, id }]), nextId: id + 1 };
}
