import { describe, expect, it, vi } from "vitest";
import type { ExtraPool, InspectInput, Report, V4PositionIndex } from "@arcos/inspector";

// A marker module that throws outside a server build.
vi.mock("server-only", () => ({}));

// The index's answer, and the engine itself: these tests only check what cachedInspection hands the engine.
const { indexedExtrasFor, inspect } = vi.hoisted(() => ({
  indexedExtrasFor: vi.fn<(token: string) => Promise<{ extraPools: ExtraPool[]; v4Positions?: V4PositionIndex }>>(),
  inspect: vi.fn<(input: InspectInput) => Promise<Report>>(),
}));
vi.mock("../indexed-pools-server", () => ({ indexedExtrasFor }));
vi.mock("@arcos/inspector", async (original) => ({ ...(await original<typeof import("@arcos/inspector")>()), inspect }));

import { cachedInspection } from "../inspect-server";

const KEY = {
  currency0: "0x0000000000000000000000000000000000000000",
  currency1: "0x470f09ae20163d5e243f6530fb328912a8fcb099",
  fee: 10_000,
  tickSpacing: 200,
  hooks: "0x83139c02ee291298baef473a775c2e996c066044",
} as const;

describe("cachedInspection", () => {
  it("hands the engine the index's pools for the token, hooked ones included", async () => {
    indexedExtrasFor.mockResolvedValue({ extraPools: [{ version: "v4", key: KEY }] });
    inspect.mockResolvedValue({ degraded: false } as Report);
    await cachedInspection("0x0000000000000000000000000000000000a6a6a1");
    expect(indexedExtrasFor).toHaveBeenCalledWith("0x0000000000000000000000000000000000a6a6a1");
    expect(inspect.mock.calls[0]![0].extraPools).toEqual([{ version: "v4", key: KEY }]);
    expect(inspect.mock.calls[0]![0]).not.toHaveProperty("v4Positions");
  });

  it("hands the engine the index's positions for the token's v4 pools when it has them", async () => {
    const v4Positions: V4PositionIndex = { cursor: 32_000_000, pools: { [`0x${"9e".repeat(32)}`]: { positions: [], truncated: false } } };
    indexedExtrasFor.mockResolvedValue({ extraPools: [{ version: "v4", key: KEY }], v4Positions });
    inspect.mockResolvedValue({ degraded: false } as Report);
    await cachedInspection("0x0000000000000000000000000000000000a6a6a3");
    expect(inspect.mock.calls.at(-1)![0].v4Positions).toEqual(v4Positions);
  });

  it("inspects without extra pools when the index has none to give", async () => {
    indexedExtrasFor.mockResolvedValue({ extraPools: [] });
    inspect.mockResolvedValue({ degraded: false } as Report);
    await cachedInspection("0x0000000000000000000000000000000000a6a6a2");
    expect(inspect.mock.calls.at(-1)![0].extraPools).toBeUndefined();
  });
});
