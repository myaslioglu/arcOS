import type { TimestampLike } from "../../timestamps";

/** A stand-in for firebase-admin's Timestamp, so the pure code is tested without the Admin SDK. */
export const at = (millis: number): TimestampLike => ({
  seconds: Math.floor(millis / 1000),
  nanoseconds: (millis % 1000) * 1_000_000,
  toDate: () => new Date(millis),
  toMillis: () => millis,
});
