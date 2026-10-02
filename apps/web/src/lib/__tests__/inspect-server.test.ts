import { describe, expect, it, vi } from "vitest";
import type { ExtraPool, InspectInput, Report } from "@arcos/inspector";

// A marker module that throws outside a server build.
vi.mock("server-only", () => ({}));

// The index's answer, and the engine itself: these tests only check what cachedInspection hands the engine.
const { extraPoolsFor, inspect } = vi.hoisted(() => ({
  extraPoolsFor: vi.fn<(token: string) => Promise<ExtraPool[]>>(),
  inspect: vi.fn<(input: InspectInput) => Promise<Report>>(),
}));
vi.mock("../indexed-pools-server", () => ({ extraPoolsFor }));
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
    extraPoolsFor.mockResolvedValue([{ version: "v4", key: KEY }]);
    inspect.mockResolvedValue({ degraded: false } as Report);
    await cachedInspection("0x0000000000000000000000000000000000a6a6a1");
    expect(extraPoolsFor).toHaveBeenCalledWith("0x0000000000000000000000000000000000a6a6a1");
    expect(inspect.mock.calls[0]![0].extraPools).toEqual([{ version: "v4", key: KEY }]);
  });

  it("inspects without extra pools when the index has none to give", async () => {
    extraPoolsFor.mockResolvedValue([]);
    inspect.mockResolvedValue({ degraded: false } as Report);
    await cachedInspection("0x0000000000000000000000000000000000a6a6a2");
    expect(inspect.mock.calls.at(-1)![0].extraPools).toBeUndefined();
  });
});
