import { describe, expect, it } from "vitest";
import type { PoolDoc } from "../docs";
import { v4PoolKeys } from "../pools";

const key = (fee: number, hooks = "0x0000000000000000000000000000000000000000") =>
  ({
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: "0x1111111111111111111111111111111111111111",
    fee,
    tickSpacing: 60,
    hooks,
  }) as NonNullable<PoolDoc["key"]>;

describe("v4PoolKeys", () => {
  it("keeps the v4 keys, in order, and leaves out the other versions and a v4 doc without a key", () => {
    const pools = [
      { version: "v3", key: null },
      { version: "v4", key: key(3000) },
      { version: "v4", key: null },
      { version: "aero", key: null },
      { version: "v4", key: key(500, "0x2222222222222222222222222222222222222222") },
    ] as Pick<PoolDoc, "version" | "key">[];
    expect(v4PoolKeys(pools)).toEqual([key(3000), key(500, "0x2222222222222222222222222222222222222222")]);
  });

  it("returns each key once, and copies only the five key fields", () => {
    const stray = { ...key(3000), extra: 1 } as NonNullable<PoolDoc["key"]>;
    expect(v4PoolKeys([{ version: "v4", key: stray }, { version: "v4", key: key(3000) }])).toEqual([key(3000)]);
  });
});
