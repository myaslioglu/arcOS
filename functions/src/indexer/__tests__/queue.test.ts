import { describe, expect, it } from "vitest";
import { INSPECT_PRIORITY, INSPECT_QUEUE_MAX_AGE_MS, type TokenDoc } from "@arcos/data";
import { MAX_ATTEMPTS, afterFailure, newInspect, pickQueue, queueOrder, requeue } from "../queue";
import { at, token } from "./helpers";

const NOW = 1_790_000_000_000;

describe("newInspect", () => {
  it("queues a token with a pool above one without, from now", () => {
    expect(newInspect(true, true, at(NOW))).toEqual({ state: "queued", priority: INSPECT_PRIORITY.pooled, attempts: 0, queuedAt: at(NOW) });
    expect(newInspect(true, false, at(NOW))).toEqual({ state: "queued", priority: INSPECT_PRIORITY.bare, attempts: 0, queuedAt: at(NOW) });
  });

  it("skips it while the console's inspect switch is off: it is inspected when someone opens it", () => {
    expect(newInspect(false, true, at(NOW))).toEqual({ state: "skipped", priority: INSPECT_PRIORITY.pooled, attempts: 0, queuedAt: null });
  });
});

describe("requeue, when a new pool appears for a known token", () => {
  it("queues an inspected token again, a liquid one first", () => {
    const liquid = token({ inspect: { state: "done", priority: 1, attempts: 0, queuedAt: null }, radar: { liquid: true, passing: false } });
    expect(requeue(liquid, true, at(NOW))).toEqual({ state: "queued", priority: INSPECT_PRIORITY.liquid, attempts: 0, queuedAt: at(NOW) });
    const thin = token({ inspect: { state: "skipped", priority: 0, attempts: 3, queuedAt: null } });
    expect(requeue(thin, true, at(NOW))).toEqual({ state: "queued", priority: INSPECT_PRIORITY.pooled, attempts: 0, queuedAt: at(NOW) });
  });

  it("raises a queued token without a pool to the pooled priority, keeping its place in time", () => {
    const bare = token({ inspect: { state: "queued", priority: INSPECT_PRIORITY.bare, attempts: 1, queuedAt: at(NOW - 5) } });
    expect(requeue(bare, true, at(NOW))).toEqual({ state: "queued", priority: INSPECT_PRIORITY.pooled, attempts: 1, queuedAt: at(NOW - 5) });
  });

  it("changes nothing for a token already queued at that priority or above, or while inspections are off", () => {
    const queued = token({ inspect: { state: "queued", priority: INSPECT_PRIORITY.pooled, attempts: 0, queuedAt: at(NOW - 5) } });
    expect(requeue(queued, true, at(NOW))).toBeNull();
    expect(requeue(token({ inspect: { state: "done", priority: 1, attempts: 0, queuedAt: null } }), false, at(NOW))).toBeNull();
  });
});

describe("queueOrder and pickQueue", () => {
  const q = (address: string, priority: number, firstSeen: number, queuedAt = NOW - 60_000): TokenDoc =>
    token({ address: address as `0x${string}`, firstSeen: at(firstSeen), inspect: { state: "queued", priority, attempts: 0, queuedAt: at(queuedAt) } });

  it("orders by priority, then the newest token first", () => {
    const tokens = [q("0x0000000000000000000000000000000000000001", 1, NOW - 10), q("0x0000000000000000000000000000000000000002", 2, NOW - 99), q("0x0000000000000000000000000000000000000003", 1, NOW - 5)];
    expect([...tokens].sort(queueOrder).map((t) => t.address.slice(-1))).toEqual(["2", "3", "1"]);
  });

  it("takes the first `perTick` that are fresh, and expires every one queued 24 hours ago or more", () => {
    const stale = q("0x0000000000000000000000000000000000000004", 2, NOW - 1, NOW - INSPECT_QUEUE_MAX_AGE_MS);
    const fresh = [1, 2, 3, 5].map((n) => q(`0x000000000000000000000000000000000000000${n}`, 1, NOW - n));
    const picked = pickQueue([stale, ...fresh], at(NOW), 3);
    expect(picked.inspect.map((t) => t.address.slice(-1))).toEqual(["1", "2", "3"]);
    expect(picked.expire.map((t) => t.address.slice(-1))).toEqual(["4"]);
  });

  it("expires a queued token that has no queuedAt, which the queue can't age", () => {
    const lost = token({ inspect: { state: "queued", priority: 1, attempts: 0, queuedAt: null } });
    expect(pickQueue([lost], at(NOW), 3)).toEqual({ inspect: [], expire: [lost] });
  });
});

describe("afterFailure", () => {
  it("counts a failed attempt, and skips the token after the third", () => {
    const first = afterFailure({ state: "queued", priority: 1, attempts: 0, queuedAt: at(NOW) });
    expect(first).toEqual({ state: "queued", priority: 1, attempts: 1, queuedAt: at(NOW) });
    expect(MAX_ATTEMPTS).toBe(3);
    expect(afterFailure({ state: "queued", priority: 1, attempts: 2, queuedAt: at(NOW) })).toEqual({ state: "skipped", priority: 1, attempts: 3, queuedAt: null });
  });
});
