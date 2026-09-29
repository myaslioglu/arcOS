import type { TimestampLike } from "../../timestamps";

/**
 * A stand-in for firebase-admin's Timestamp, so the pure code is tested without the Admin SDK. A class, so two of them
 * for the same millisecond are deeply equal, as two real Timestamps are.
 */
class FakeTimestamp implements TimestampLike {
  constructor(readonly millis: number) {}

  get seconds(): number {
    return Math.floor(this.millis / 1000);
  }

  get nanoseconds(): number {
    return (this.millis % 1000) * 1_000_000;
  }

  toDate(): Date {
    return new Date(this.millis);
  }

  toMillis(): number {
    return this.millis;
  }
}

export const at = (millis: number): TimestampLike => new FakeTimestamp(millis);
