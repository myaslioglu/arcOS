import { describe, expect, it, vi } from "vitest";
import { fetchPulse, pulseCaption, pulseQuery } from "../pulse-client";

describe("fetchPulse", () => {
  it("reads the route's answer", async () => {
    const fetchFn = vi.fn(async () => Response.json({ oldestBlock: 7, ratios: [0.1, 0.2] }));
    expect(await fetchPulse(fetchFn as unknown as typeof fetch)).toEqual({ oldestBlock: 7, ratios: [0.1, 0.2] });
    expect(fetchFn).toHaveBeenCalledWith("/api/pulse");
  });

  it("fails on an error status or a body that isn't a pulse", async () => {
    const unavailable = async () => Response.json({ error: "unavailable" }, { status: 503 });
    const odd = async () => Response.json({ nope: 1 });
    await expect(fetchPulse(unavailable as unknown as typeof fetch)).rejects.toThrow();
    await expect(fetchPulse(odd as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe("pulseQuery", () => {
  it("asks on mount, then every 60 s, and not while the page is hidden", () => {
    expect(pulseQuery.queryKey).toEqual(["pulse"]);
    expect(pulseQuery.refetchInterval).toBe(60_000);
    expect(pulseQuery.refetchIntervalInBackground).toBe(false);
    expect(pulseQuery.retry).toBe(false);
  });
});

describe("pulseCaption", () => {
  it("names the window it draws", () => {
    expect(pulseCaption(1024)).toBe("arc · observed / trend · last 1,024 blocks");
  });
});
