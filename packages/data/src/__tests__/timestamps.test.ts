import { describe, expect, it } from "vitest";
import { isExpired, type TimestampLike } from "../timestamps";
import { at } from "./helpers/timestamp";

const NOW = new Date("2026-09-29T12:00:00.000Z");

describe("isExpired", () => {
  it("is false until the very millisecond of expiry, then true", () => {
    const expiresAt = at(NOW.getTime());
    expect(isExpired(expiresAt, new Date(NOW.getTime() - 1))).toBe(false);
    expect(isExpired(expiresAt, NOW)).toBe(true);
    expect(isExpired(expiresAt, new Date(NOW.getTime() + 1))).toBe(true);
  });

  it("reads only toMillis(), the one member a Firestore Timestamp and a test double share", () => {
    const onlyMillis = { toMillis: () => NOW.getTime() + 60_000 } as TimestampLike;
    expect(isExpired(onlyMillis, NOW)).toBe(false);
  });
});
