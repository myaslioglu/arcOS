import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { Approval } from "@/lib/approvals";
import type { RowOutcome } from "../flow";
import { ALLOWANCE_STILL_SET, rowKey } from "../rows";
import { revokeSession } from "../session";

/**
 * The revoke session lives outside any window, as Drop's send does: closing Revoke mid-revoke unmounts its component,
 * and a window opened again must show the revoke still running, then how it ended.
 */

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const TOKEN: Address = "0x3333333333333333333333333333333333333333";
const row = (spender: string): Approval => ({
  kind: "erc20",
  token: TOKEN,
  symbol: "AAA",
  name: null,
  decimals: 18,
  spender: spender as Address,
  spenderLabel: null,
  allowance: "1",
  lastApprovalBlock: 1,
});
const A = row("0x5555555555555555555555555555555555555555");
const B = row("0x6666666666666666666666666666666666666666");
const C = row("0x7777777777777777777777777777777777777777");

/** A step runner whose steps each wait for the test to settle them. */
function manual() {
  const pending: { rows: Approval[]; settle: (o: RowOutcome[]) => void }[] = [];
  const execute = (rows: Approval[]) => new Promise<RowOutcome[]>((settle) => pending.push({ rows, settle }));
  return { pending, execute };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => revokeSession.forget());

describe("revokeSession", () => {
  it("marks the current transaction sent when its step says the wallet signed, and starts each step unsent", async () => {
    const pending: { settle: (o: RowOutcome[]) => void; onSent: () => void }[] = [];
    const done = revokeSession.run(OWNER, [[A], [B]], (_rows, onSent) => new Promise<RowOutcome[]>((settle) => pending.push({ settle, onSent })));
    expect(revokeSession.getSnapshot().run).toMatchObject({ step: 1, sent: false });
    pending[0]!.onSent();
    expect(revokeSession.getSnapshot().run).toMatchObject({ step: 1, sent: true });
    pending[0]!.settle([{ key: rowKey(A), result: "revoked", block: 5 }]);
    await flush();
    expect(revokeSession.getSnapshot().run).toMatchObject({ step: 2, sent: false });
    pending[1]!.onSent();
    expect(revokeSession.getSnapshot().run).toMatchObject({ step: 2, sent: true });
    pending[1]!.settle([{ key: rowKey(B), result: "revoked", block: 6 }]);
    await done;
    // A late call, after the run ended, changes nothing.
    pending[0]!.onSent();
    expect(revokeSession.getSnapshot().run).toBeNull();
  });

  it("keeps a running revoke's progress in the store, so a window mounted mid-revoke shows it, and clears it when it ends", async () => {
    const { pending, execute } = manual();
    const listener = vi.fn();
    const unsubscribe = revokeSession.subscribe(listener);
    const done = revokeSession.run(OWNER, [[A], [B]], execute);
    expect(done).not.toBeNull();

    // The window that started it is gone (it unsubscribed); the store doesn't care.
    unsubscribe();
    expect(revokeSession.getSnapshot().run).toEqual({ owner: OWNER.toLowerCase(), step: 1, steps: 2, current: [rowKey(A)], stopping: false, sent: false });

    pending[0]!.settle([{ key: rowKey(A), result: "revoked", block: 5 }]);
    await flush();
    expect(revokeSession.getSnapshot().run).toMatchObject({ step: 2, current: [rowKey(B)] });

    pending[1]!.settle([{ key: rowKey(B), result: "failed", text: "No.", hash: "0xabc" }]);
    expect(await done).toEqual([
      { key: rowKey(A), result: "revoked", block: 5 },
      { key: rowKey(B), result: "failed", text: "No.", hash: "0xabc" },
    ]);
    const after = revokeSession.getSnapshot();
    expect(after.run).toBeNull();
    // A window opened now shows the failure where the row is.
    expect(revokeSession.ownerState(after, OWNER).failures).toEqual({ [rowKey(B)]: { text: "No.", hash: "0xabc" } });
  });

  it("refuses a second revoke while one runs, from any window", () => {
    const { execute } = manual();
    expect(revokeSession.run(OWNER, [[A]], execute)).not.toBeNull();
    expect(revokeSession.run(OWNER, [[B]], execute)).toBeNull();
  });

  it("stops at the first failure, leaving the rest untouched", async () => {
    const { pending, execute } = manual();
    const done = revokeSession.run(OWNER, [[A], [B], [C]], execute);
    pending[0]!.settle([{ key: rowKey(A), result: "failed", text: "Refused." }]);
    expect(await done).toEqual([{ key: rowKey(A), result: "failed", text: "Refused." }]);
    expect(pending).toHaveLength(1);
  });

  it("stops after the current transaction when asked to", async () => {
    const { pending, execute } = manual();
    const done = revokeSession.run(OWNER, [[A], [B]], execute);
    revokeSession.stop();
    expect(revokeSession.getSnapshot().run?.stopping).toBe(true);
    pending[0]!.settle([{ key: rowKey(A), result: "revoked", block: 5 }]);
    expect(await done).toEqual([{ key: rowKey(A), result: "revoked", block: 5 }]);
    expect(pending).toHaveLength(1);
  });

  it("records what is left after a confirmed revoke, and clears a row's old failure when it is tried again", async () => {
    const first = manual();
    const once = revokeSession.run(OWNER, [[A]], first.execute);
    first.pending[0]!.settle([{ key: rowKey(A), result: "still-set", left: "40", hash: "0xdef" }]);
    await once;
    const state = revokeSession.ownerState(revokeSession.getSnapshot(), OWNER);
    expect(state.left).toEqual({ [rowKey(A)]: "40" });
    expect(state.failures[rowKey(A)]).toEqual({ text: ALLOWANCE_STILL_SET, hash: "0xdef" });

    const second = manual();
    void revokeSession.run(OWNER, [[A]], second.execute);
    expect(revokeSession.ownerState(revokeSession.getSnapshot(), OWNER).failures).toEqual({});
  });

  it("keeps each owner's failures apart", async () => {
    const OTHER: Address = "0x2222222222222222222222222222222222222222";
    const { pending, execute } = manual();
    const done = revokeSession.run(OWNER, [[A]], execute);
    pending[0]!.settle([{ key: rowKey(A), result: "failed", text: "No." }]);
    await done;
    expect(revokeSession.ownerState(revokeSession.getSnapshot(), OTHER).failures).toEqual({});
  });

  it("ends the run, failing the step's rows, when the step itself throws", async () => {
    const done = revokeSession.run(OWNER, [[A, B]], async () => {
      throw new Error("bug");
    });
    expect(await done).toEqual([
      { key: rowKey(A), result: "failed", text: expect.any(String) },
      { key: rowKey(B), result: "failed", text: expect.any(String) },
    ]);
    expect(revokeSession.getSnapshot().run).toBeNull();
  });
});

describe("revokeSession's onEnd", () => {
  it("hears every outcome before the run is cleared, so a window waiting for the end already knows it", async () => {
    const seen: unknown[] = [];
    const done = revokeSession.run(
      OWNER,
      [[A]],
      async () => [{ key: rowKey(A), result: "revoked", block: 1 }],
      (outcomes) => seen.push([outcomes, revokeSession.getSnapshot().run !== null]),
    );
    await done;
    expect(seen).toEqual([[[{ key: rowKey(A), result: "revoked", block: 1 }], true]]);
  });
});
