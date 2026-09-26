import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@arcos/inspector";

// The real module is server-only and opens an RPC client when it loads; these routes only need its answer.
const { cachedInspection } = vi.hoisted(() => ({ cachedInspection: vi.fn<(address: string) => Promise<Report>>() }));
vi.mock("@/lib/inspect-server", async () => {
  const { InspectionTimeout } = await import("@/lib/deadline");
  return { cachedInspection, InspectionTimeout, InspectorBusy: class InspectorBusy extends Error {} };
});

import { InspectorBusy } from "@/lib/inspect-server";
import { GET as inspectRoute } from "@/app/api/inspect/[address]/route";
import { GET as badgeRoute } from "@/app/badge/[address]/route";
import OgImage from "@/app/t/[address]/opengraph-image";

const ADDRESS = "0x1111111111111111111111111111111111111111";

const report = (degraded: boolean): Report => ({
  address: ADDRESS,
  network: "mainnet",
  token: { name: "Duke", symbol: "DUKE", decimals: 18, totalSupply: "1" },
  findings: [],
  passed: 0,
  total: 0,
  counts: { pass: 0, warn: 0, fail: 0, unknown: 0 },
  explorerReachable: true,
  degraded,
  blockNumber: "1",
  generatedAt: "2026-09-27T00:00:00.000Z",
});

const params = () => ({ params: Promise.resolve({ address: ADDRESS }) });
const surfaces: [string, () => Promise<Response>][] = [
  ["/api/inspect", () => inspectRoute(new Request(`https://4rcos.test/api/inspect/${ADDRESS}`), params())],
  ["/badge", () => badgeRoute(new Request(`https://4rcos.test/badge/${ADDRESS}`), params())],
  ["the OG image", () => OgImage(params())],
];
const cacheControl = async (get: () => Promise<Response>) => {
  const res = await get();
  await res.arrayBuffer(); // the OG image renders as its body is read: finish that here, not after the test
  return res.headers.get("cache-control");
};

describe("how long a CDN may keep what an inspection rendered", () => {
  beforeEach(() => {
    cachedInspection.mockReset();
  });

  it.each(surfaces)("%s: a clean report for 5 minutes", async (_, get) => {
    cachedInspection.mockResolvedValue(report(false));
    expect(await cacheControl(get)).toBe("public, s-maxage=300, stale-while-revalidate=600");
  });

  it.each(surfaces)("%s: a degraded report for 30 seconds, with nothing served stale after that", async (_, get) => {
    cachedInspection.mockResolvedValue(report(true));
    expect(await cacheControl(get)).toBe("public, s-maxage=30");
  });

  it.each(surfaces.slice(1))("%s: a failed inspection for 5 seconds", async (_, get) => {
    cachedInspection.mockRejectedValue(new InspectorBusy());
    expect(await cacheControl(get)).toBe("public, s-maxage=5");
  });
});
