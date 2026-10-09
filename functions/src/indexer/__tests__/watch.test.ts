import { describe, expect, it } from "vitest";
import { DELIVERY_MAX_ATTEMPTS } from "@arcos/data";
import { UNAUTHORIZED_PAUSE_MS } from "../telegram";
import { MESSAGE_MAX_CHARS, WATCH, alertMessage, nextDelivery } from "../watch";

const NOW = 1_790_000_000_000;

describe("nextDelivery", () => {
  it("marks a delivery sent on ok, with the attempt counted and the time", () => {
    const step = nextDelivery({ attempts: 2 }, { kind: "ok" }, NOW);
    expect(step.unlink).toBe(false);
    expect(step.pauseMs).toBeNull();
    expect(step.update).toMatchObject({ status: "sent", attempts: 3, error: null });
    expect(step.update?.deliveredAt?.toMillis()).toBe(NOW);
  });

  it("keeps a retryable failure pending with its code, and fails it on the fourth attempt", () => {
    for (const kind of ["telegram_5xx", "timeout", "network"] as const) {
      const outcome = kind === "telegram_5xx" ? { kind, status: 503 } : { kind };
      expect(nextDelivery({ attempts: 0 }, outcome, NOW)).toEqual({ update: { status: "pending", attempts: 1, error: kind }, unlink: false, pauseMs: null });
      expect(nextDelivery({ attempts: DELIVERY_MAX_ATTEMPTS - 2 }, outcome, NOW).update).toMatchObject({ status: "pending", attempts: DELIVERY_MAX_ATTEMPTS - 1 });
      expect(nextDelivery({ attempts: DELIVERY_MAX_ATTEMPTS - 1 }, outcome, NOW).update).toMatchObject({ status: "failed", attempts: DELIVERY_MAX_ATTEMPTS, error: kind });
    }
    expect(DELIVERY_MAX_ATTEMPTS).toBe(4);
  });

  it("fails a blocked or vanished chat at once and unlinks it; fails a refused message without unlinking", () => {
    expect(nextDelivery({ attempts: 0 }, { kind: "blocked" }, NOW)).toEqual({ update: { status: "failed", attempts: 1, error: "blocked" }, unlink: true, pauseMs: null });
    expect(nextDelivery({ attempts: 1 }, { kind: "chat_not_found" }, NOW)).toEqual({ update: { status: "failed", attempts: 2, error: "chat_not_found" }, unlink: true, pauseMs: null });
    expect(nextDelivery({ attempts: 0 }, { kind: "bad_request" }, NOW)).toEqual({ update: { status: "failed", attempts: 1, error: "bad_request" }, unlink: false, pauseMs: null });
  });

  it("leaves the delivery untouched and pauses sends on a rate limit (the seconds asked) or a refused token (10 minutes)", () => {
    expect(nextDelivery({ attempts: 3 }, { kind: "rate_limited", retryAfterSec: 7 }, NOW)).toEqual({ update: null, unlink: false, pauseMs: 7_000 });
    expect(nextDelivery({ attempts: 3 }, { kind: "unauthorized" }, NOW)).toEqual({ update: null, unlink: false, pauseMs: UNAUTHORIZED_PAUSE_MS });
    expect(UNAUTHORIZED_PAUSE_MS).toBe(600_000);
  });
});

describe("alertMessage", () => {
  it("is the words, a dash and the link, cut to Telegram's 4,096 characters", () => {
    expect(alertMessage("DUKE (0x8f3a…913c): paused at block 1,234,567", "https://explorer.arc.io/token/0x8f3a")).toBe(
      "DUKE (0x8f3a…913c): paused at block 1,234,567 — https://explorer.arc.io/token/0x8f3a",
    );
    const long = alertMessage("x".repeat(5_000), "https://explorer.arc.io/token/0x8f3a");
    expect([...long]).toHaveLength(MESSAGE_MAX_CHARS);
    expect(MESSAGE_MAX_CHARS).toBe(4_096);
  });
});

describe("WATCH", () => {
  it("holds the design's caps", () => {
    expect(WATCH).toMatchObject({ tokensPerRun: 40, readConcurrency: 4, fanoutPerRun: 1_000, sendsPerRun: 60, sendConcurrency: 4, perChatPerRun: 3, breaker: 3 });
  });
});
