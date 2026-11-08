import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsAnswer } from "@arcos/data";

// The real module is server-only and opens Firestore; the route only needs its answer.
const { statsNumbers } = vi.hoisted(() => ({ statsNumbers: vi.fn<() => Promise<StatsAnswer>>() }));
vi.mock("@/lib/stats-server", () => ({ statsNumbers }));

import { GET } from "@/app/api/stats/route";
import { IndexUnavailable } from "@/lib/index-source";

const answer: StatsAnswer = {
  version: 1,
  network: "arc-mainnet",
  asOf: { block: 24_012_345, at: "2026-11-08T12:00:00.000Z", behind: 3 },
  counts: [
    {
      id: "tokens_created",
      label: "Tokens created with Mint",
      value: 1234,
      since: "2026-09-25",
      source: "onchain",
      parts: [{ id: "standard", label: "Standard", value: 1234 }],
      verify: {
        event: "TokenCreated(address,address,address,string,string,uint8,uint256,uint256,bool,bool)",
        how: "Count the events.",
        contracts: [{ label: "TokenFactory", address: "0xa68edD822048C00dC816d93005B72F8a50234a24", explorer: "https://explorer.arc.io/address/0xa68edD822048C00dC816d93005B72F8a50234a24?tab=logs" }],
      },
    },
    { id: "wallets_signed_in", label: "Wallets signed in", value: 212, since: "2026-10-14", source: "server" },
  ],
  notes: ["Automated counts."],
};

let ip = 0;
const get = () => GET(new Request("https://4rcos.test/api/stats", { headers: { "x-forwarded-for": `198.51.100.${++ip % 250}` } }));

describe("GET /api/stats", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    statsNumbers.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is not there on testnet, which keeps no counts, and reads nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ error: "Not available on this network." });
    expect(statsNumbers).not.toHaveBeenCalled();
  });

  it("is not there when the network isn't set at all (the default is testnet)", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", undefined);
    expect((await get()).status).toBe(404);
    expect(statsNumbers).not.toHaveBeenCalled();
  });

  it("answers the counts as they are, kept 60 s at the CDN and open to any origin", async () => {
    statsNumbers.mockResolvedValue(answer);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual(answer);
  });

  it("answers the shape the window reads: version, network, asOf, counts with id, label, value, since and source, notes", async () => {
    statsNumbers.mockResolvedValue(answer);
    const body = (await (await get()).json()) as StatsAnswer;
    expect(Object.keys(body).sort()).toEqual(["asOf", "counts", "network", "notes", "version"]);
    expect(body.version).toBe(1);
    expect(body.network).toBe("arc-mainnet");
    for (const count of body.counts) {
      expect(count).toMatchObject({ id: expect.any(String) as string, label: expect.any(String) as string, value: expect.any(Number) as number });
      expect(["onchain", "server"]).toContain(count.source);
    }
  });

  it("answers an empty list with a 200 before counting began", async () => {
    statsNumbers.mockResolvedValue({ version: 1, network: "arc-mainnet", asOf: null, counts: [], notes: [] });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ asOf: null, counts: [] });
  });

  it("limits each client to 60 requests a minute, with the CORS header on the refusal too", async () => {
    statsNumbers.mockResolvedValue(answer);
    const req = () => GET(new Request("https://4rcos.test/api/stats", { headers: { "x-forwarded-for": "203.0.113.9" } }));
    for (let i = 0; i < 60; i++) expect((await req()).status).toBe(200);
    const res = await req();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(statsNumbers).toHaveBeenCalledTimes(60);
  });

  it("answers 503, uncached, when the counts can't be read, logging the error's name and its gRPC code only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    statsNumbers.mockRejectedValue(new IndexUnavailable(undefined, { cause: { code: 7, message: "projects/demo-x/databases/arcos" } }));
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ error: "The usage counts can't be read right now." });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("stats failed", "IndexUnavailable", 7);
    for (const arg of log.mock.calls.flat()) {
      expect(String(arg)).not.toContain("demo-");
      expect(String(arg)).not.toContain("databases");
    }

    log.mockClear();
    statsNumbers.mockRejectedValue(new IndexUnavailable("This server doesn't read the usage counts."));
    expect((await get()).status).toBe(503);
    expect(log).toHaveBeenCalledWith("stats failed", "IndexUnavailable");
    expect(log.mock.calls.flat().some((v) => String(v).includes("doesn't read"))).toBe(false);
    log.mockRestore();
  });
});
