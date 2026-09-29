/**
 * The part of firebase-admin's Timestamp that pure code reads. The real class satisfies it, so callers pass real
 * Timestamps in and this package never constructs one.
 */
export interface TimestampLike {
  readonly seconds: number;
  readonly nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
}

/** Firestore deletes an expired doc within about a day, so code that reads a nonce or a link code checks this itself. */
export function isExpired(expiresAt: TimestampLike, now: Date): boolean {
  return expiresAt.toMillis() <= now.getTime();
}
