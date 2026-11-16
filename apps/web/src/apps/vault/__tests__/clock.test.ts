import { describe, expect, it } from "vitest";
import { chainNow } from "../clock";

describe("chainNow", () => {
  it("is the latest block's time plus the whole seconds since it was read", () => {
    const sample = { chain: 1_900_000_000, at: 1_000_000 };
    expect(chainNow(sample, 1_000_000)).toBe(1_900_000_000);
    expect(chainNow(sample, 1_015_999)).toBe(1_900_000_015);
  });

  it("follows the chain, not the local clock: a test chain moved 400 days ahead reads 400 days ahead", () => {
    const local = 1_800_000_000_000;
    expect(chainNow({ chain: 1_800_000_000 + 400 * 86_400, at: local }, local + 1000)).toBe(1_800_000_000 + 400 * 86_400 + 1);
  });

  it("never runs backwards when the local clock steps back, and stands in with the local clock until a block is read", () => {
    expect(chainNow({ chain: 5, at: 10_000 }, 9_000)).toBe(5);
    expect(chainNow(undefined, 1_234_567)).toBe(1_234);
  });
});
