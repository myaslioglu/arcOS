import { beforeEach, describe, expect, it, vi } from "vitest";

// The real module is server-only and opens an RPC client when it loads; the route only needs its answer.
const { cachedPulse } = vi.hoisted(() => ({ cachedPulse: vi.fn() }));
vi.mock("@/lib/pulse-server", () => ({ cachedPulse }));

import { GET } from "@/app/api/pulse/route";

describe("GET /api/pulse", () => {
  beforeEach(() => {
    cachedPulse.mockReset();
  });

  it("answers the ratios, which a browser may keep for 30 s", async () => {
    cachedPulse.mockResolvedValue({ oldestBlock: 10, ratios: [0.1, 0.2] });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(await res.json()).toEqual({ oldestBlock: 10, ratios: [0.1, 0.2] });
  });

  it("answers 503 unavailable, kept by no one, when the RPC fails", async () => {
    cachedPulse.mockRejectedValue(new Error("every endpoint failed"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
