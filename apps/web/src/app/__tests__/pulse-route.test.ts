import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real module is server-only and opens an RPC client when it loads; the route only needs its answer.
const { cachedPulse } = vi.hoisted(() => ({ cachedPulse: vi.fn() }));
vi.mock("@/lib/pulse-server", () => ({ cachedPulse }));

import { GET } from "@/app/api/pulse/route";
import { toPulse } from "@/lib/pulse";

describe("GET /api/pulse", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    cachedPulse.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers the ratios, which a browser may keep for 30 s", async () => {
    cachedPulse.mockResolvedValue({ oldestBlock: 10, ratios: [0.1, 0.2] });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(await res.json()).toEqual({ oldestBlock: 10, ratios: [0.1, 0.2] });
  });

  it("answers 503 unavailable, kept by no one, when the RPC fails, logging only the error's name", async () => {
    cachedPulse.mockRejectedValue(new Error("every endpoint failed"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(errorSpy).toHaveBeenCalledWith("pulse failed", "Error");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  // The real toPulse in place of the cache: a fee history the chart can't be drawn from ends as a 503 like any other
  // failure, and the log names it as a refusal, which a plain Error from the RPC never is.
  it("logs a refused fee history as PulseRefused, and still answers 503 unavailable", async () => {
    cachedPulse.mockImplementation(async () => toPulse({ oldestBlock: 5n, gasUsedRatio: [0.5] }));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(errorSpy).toHaveBeenCalledWith("pulse failed", "PulseRefused");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("never logs the failure's message, only its name — the message could carry an RPC endpoint's URL", async () => {
    cachedPulse.mockRejectedValue(new Error("https://secret-rpc.example/abc123 timed out"));
    await GET();
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) expect(String(arg)).not.toContain("secret-rpc");
    }
  });
});
