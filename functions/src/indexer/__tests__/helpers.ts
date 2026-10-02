import type { TimestampLike, TokenDoc } from "@arcos/data";

/** A stand-in for firebase-admin's Timestamp in the pure tests. A class, so two for the same millisecond are equal. */
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

/** A token doc as the index stores it, with `over` on top. */
export function token(over: Partial<TokenDoc> = {}): TokenDoc {
  return {
    network: "mainnet",
    address: "0x470f09ae20163d5e243f6530fb328912a8fcb099",
    name: null,
    symbol: null,
    decimals: null,
    totalSupply: null,
    source: "v4",
    creator: null,
    firstBlock: 23_822_520,
    firstSeen: at(1_790_000_000_000),
    bestPool: null,
    report: null,
    radar: { liquid: false, passing: false },
    inspect: { state: "queued", priority: 1, attempts: 0, queuedAt: at(1_790_000_000_000) },
    launchpad: null,
    ...over,
  };
}
