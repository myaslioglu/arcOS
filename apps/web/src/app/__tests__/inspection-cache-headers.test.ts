import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@arcos/inspector";

// The real module is server-only and opens an RPC client when it loads; these routes only need its answer.
const { cachedInspection } = vi.hoisted(() => ({ cachedInspection: vi.fn<(address: string) => Promise<Report>>() }));
vi.mock("@/lib/inspect-server", () => ({
  cachedInspection,
  InspectorBusy: class InspectorBusy extends Error {
    override name = "InspectorBusy";
  },
}));

import { InspectorBusy } from "@/lib/inspect-server";
import { GET as inspectRoute } from "@/app/api/inspect/[address]/route";
import { GET as badgeRoute } from "@/app/badge/[address]/route";
import OgImage, * as ogRoute from "@/app/t/[address]/opengraph-image";
import ProofPage, { generateMetadata } from "@/app/t/[address]/page";

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

// The report cache and the in-flight gate are one per process, shared by every bundled copy of inspect-server.ts, so
// the error an inspection ends with may come from another copy's class. The routes tell outcomes apart by name.
describe("an inspection that ended without a report, whichever bundled copy threw the error", () => {
  const fromAnotherCopy = (name: string) => Object.assign(new Error("from another copy"), { name });
  const inspect = () => inspectRoute(new Request(`https://4rcos.test/api/inspect/${ADDRESS}`), params());

  beforeEach(() => {
    cachedInspection.mockReset();
  });

  it("answers 503 to backpressure, not 502", async () => {
    cachedInspection.mockRejectedValue(fromAnotherCopy("InspectorBusy"));
    expect((await inspect()).status).toBe(503);
    cachedInspection.mockRejectedValue(fromAnotherCopy("InspectionTimeout"));
    expect((await inspect()).status).toBe(503);
  });

  it("the proof page reads backpressure from another copy as busy, not as an error (review PAGE1)", async () => {
    for (const name of ["InspectorBusy", "InspectionTimeout"]) {
      cachedInspection.mockRejectedValue(fromAnotherCopy(name));
      expect((await generateMetadata(params())).title).toBe("4rc.OS is busy — try again shortly");
      const page = (await ProofPage(params())) as { props: { message?: string } };
      expect(page.props.message).toBe("4rc.OS is busy reading other tokens. Reload in a few seconds.");
    }
  });

  it("answers 404 when there's no contract, not 502", async () => {
    cachedInspection.mockRejectedValue(fromAnotherCopy("NotAContract"));
    expect((await inspect()).status).toBe(404);
  });
});

// The way the approvals and pulse routes log: the error's name only, since a node's or an explorer's message can carry
// an endpoint's URL, and the address a visitor looked up isn't the log's to keep either.
describe("what the Inspector route logs when an inspection fails", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const inspect = () => inspectRoute(new Request(`https://4rcos.test/api/inspect/${ADDRESS}`), params());

  beforeEach(() => {
    cachedInspection.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs one line naming the error, and answers 502", async () => {
    cachedInspection.mockRejectedValue(new TypeError("fetch failed"));
    expect((await inspect()).status).toBe(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("inspect failed", "TypeError");
  });

  it("never logs the failure's message or the address, only its name", async () => {
    cachedInspection.mockRejectedValue(new Error("https://secret-rpc.example/abc123 timed out"));
    await inspect();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain("secret-rpc");
        expect(String(arg)).not.toContain(ADDRESS);
      }
    }
  });

  it("logs 'unknown' for a failure that isn't an Error", async () => {
    cachedInspection.mockRejectedValue("https://secret-rpc.example/abc123 timed out");
    expect((await inspect()).status).toBe(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("inspect failed", "unknown");
  });

  it("logs nothing for the answers that aren't failures: no contract, and busy", async () => {
    cachedInspection.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAContract" }));
    expect((await inspect()).status).toBe(404);
    cachedInspection.mockRejectedValue(Object.assign(new Error("x"), { name: "InspectorBusy" }));
    expect((await inspect()).status).toBe(503);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// The badge, the social card and the proof page log the way the Inspector route does, and for the same reason: the
// error's name only, under their own label. The proof page reads the chain from two places, its metadata and its body,
// so both are pinned.
describe("what the badge, the social card and the proof page log when an inspection fails", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const drain = async (res: Response) => void (await res.arrayBuffer()); // the OG image renders as its body is read
  const logging: [surface: string, label: string, run: () => Promise<unknown>][] = [
    [
      "the badge",
      "badge inspect failed",
      async () => drain(await badgeRoute(new Request(`https://4rcos.test/badge/${ADDRESS}`), params())),
    ],
    ["the OG image", "og inspect failed", async () => drain(await OgImage(params()))],
    ["the proof page's metadata", "proof page inspect failed", () => generateMetadata(params())],
    ["the proof page", "proof page inspect failed", () => ProofPage(params())],
  ];

  beforeEach(() => {
    cachedInspection.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(logging)("%s: logs one line naming the error", async (_, label, run) => {
    cachedInspection.mockRejectedValue(new TypeError("fetch failed"));
    await run();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(label, "TypeError");
  });

  it.each(logging)("%s: never logs the failure's message or the address, only its name", async (_, __, run) => {
    cachedInspection.mockRejectedValue(new Error("https://secret-rpc.example/abc123 timed out"));
    await run();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain("secret-rpc");
        expect(String(arg)).not.toContain(ADDRESS);
      }
    }
  });

  it.each(logging)("%s: logs 'unknown' for a failure that isn't an Error", async (_, label, run) => {
    cachedInspection.mockRejectedValue("https://secret-rpc.example/abc123 timed out");
    await run();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(label, "unknown");
  });
});

describe("the OG image route's config", () => {
  it("renders on every request, with no revalidate that would bring back Next's own 5-minute cache", () => {
    expect(ogRoute.dynamic).toBe("force-dynamic");
    expect("revalidate" in ogRoute).toBe(false);
  });
});
