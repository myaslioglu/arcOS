import { beforeEach, describe, expect, it } from "vitest";
import type { ActionOutcome, LockOutcome, LockStep } from "../flow";
import { isBusy, vaultSession } from "../session";

const VAULT = "0x011916e14B8399feC0109f3402d283C71250C33C";
const summary = { label: "1,000 VTB", approval: "1000 VTB", unlockAt: 1_900_000_000, kind: "token" as const, fee: 30n * 10n ** 18n, token: { symbol: "VTB", decimals: 18 } };

/** A promise the test settles when it wants. */
function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vaultSession.forget());

describe("the lock in flight", () => {
  it("reports its steps, keeps its outcome until dismissed, and survives any window (module state)", async () => {
    const done = later<LockOutcome>();
    let step!: (s: LockStep, sent: boolean) => void;
    const run = vaultSession.startLock(summary, (onStep) => {
      step = onStep;
      return done.promise;
    });
    expect(run).not.toBeNull();
    // It starts on the checks: nothing is asked of the wallet until runLock names the first step.
    expect(vaultSession.getSnapshot().lock).toEqual({ status: "running", summary, step: "check", sent: false });
    step("approve", false);
    expect(vaultSession.getSnapshot().lock).toMatchObject({ step: "approve", sent: false });
    step("approve", true);
    expect(vaultSession.getSnapshot().lock).toMatchObject({ step: "approve", sent: true });
    const outcome: LockOutcome = { result: "locked", vault: VAULT, hash: "0x01" };
    done.resolve(outcome);
    expect(await run).toEqual(outcome);
    expect(vaultSession.getSnapshot().lock).toEqual({ status: "done", summary, outcome });
    vaultSession.dismissLock();
    expect(vaultSession.getSnapshot().lock).toEqual({ status: "idle" });
  });

  it("refuses a second wallet transaction while one runs, a lock or an action", async () => {
    const done = later<LockOutcome>();
    const first = vaultSession.startLock(summary, () => done.promise);
    expect(isBusy(vaultSession.getSnapshot())).toBe(true);
    expect(vaultSession.startLock(summary, async () => ({ result: "locked", vault: VAULT, hash: "0x02" }))).toBeNull();
    expect(vaultSession.startAction(VAULT, { kind: "withdraw" }, async () => ({ result: "done", hash: "0x03", collected: [] }))).toBeNull();
    vaultSession.dismissLock(); // nothing to dismiss while it runs
    expect(vaultSession.getSnapshot().lock.status).toBe("running");
    done.resolve({ result: "failed", message: "x", approvalLeft: false });
    await first;
    expect(isBusy(vaultSession.getSnapshot())).toBe(false);
  });

  it("turns a flow that throws anyway into a failure that tells the visitor to check first", async () => {
    await vaultSession.startLock(summary, async () => {
      throw new Error("boom");
    });
    expect(vaultSession.getSnapshot().lock).toMatchObject({ status: "done", outcome: { result: "failed", message: "Something went wrong. Check Your locks before you try again." } });
  });
});

describe("an action on a vault", () => {
  it("marks the vault while it runs and when the wallet has sent, then keeps the outcome on that vault", async () => {
    const done = later<ActionOutcome>();
    let sent!: () => void;
    const run = vaultSession.startAction(VAULT, { kind: "collect" }, (onSent) => {
      sent = onSent;
      return done.promise;
    }, (o) => (o.result === "done" ? "Collected." : undefined));
    expect(vaultSession.getSnapshot().action).toEqual({ vault: VAULT.toLowerCase(), kind: "collect", sent: false });
    sent();
    expect(vaultSession.getSnapshot().action?.sent).toBe(true);
    done.resolve({ result: "done", hash: "0x04", collected: [] });
    await run;
    expect(vaultSession.getSnapshot().action).toBeNull();
    expect(vaultSession.getSnapshot().notes[VAULT.toLowerCase()]).toEqual({ action: { kind: "collect" }, outcome: { result: "done", hash: "0x04", collected: [] }, detail: "Collected." });
  });

  it("keeps the action itself with its outcome, so an extend's note can name the new date", async () => {
    await vaultSession.startAction(VAULT, { kind: "extend", unlockAt: 1_950_000_000 }, async () => ({ result: "done", hash: "0x07", collected: [] }));
    expect(vaultSession.getSnapshot().notes[VAULT.toLowerCase()]?.action).toEqual({ kind: "extend", unlockAt: 1_950_000_000 });
  });

  it("clears a vault's last note when a new action starts on it, and on dismiss", async () => {
    await vaultSession.startAction(VAULT, { kind: "extend", unlockAt: 1_950_000_000 }, async () => ({ result: "failed", message: "no" }));
    expect(vaultSession.getSnapshot().notes[VAULT.toLowerCase()]?.action.kind).toBe("extend");
    const done = later<ActionOutcome>();
    const run = vaultSession.startAction(VAULT, { kind: "withdraw" }, () => done.promise);
    expect(vaultSession.getSnapshot().notes[VAULT.toLowerCase()]).toBeUndefined();
    done.resolve({ result: "done", hash: "0x05", collected: [] });
    await run;
    vaultSession.dismissNote(VAULT.toUpperCase().replace("0X", "0x"));
    expect(vaultSession.getSnapshot().notes).toEqual({});
  });

  it("tells subscribers of every change", async () => {
    let heard = 0;
    const off = vaultSession.subscribe(() => (heard += 1));
    await vaultSession.startAction(VAULT, { kind: "accept" }, async () => ({ result: "done", hash: "0x06", collected: [] }));
    off();
    expect(heard).toBe(2);
  });
});
