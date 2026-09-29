import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real module is server-only and reads the explorer and the chain; the route only needs its answer.
const { cachedApprovals } = vi.hoisted(() => ({ cachedApprovals: vi.fn() }));
vi.mock("@/lib/approvals-server", () => ({ cachedApprovals }));

import { GET } from "@/app/api/approvals/route";

const OWNER = "0x1111111111111111111111111111111111111111";
const get = (query: string, ip = "198.51.100.7") =>
  GET(new Request(`https://4rcos.test/api/approvals${query}`, { headers: { "x-real-ip": ip } }));

describe("GET /api/approvals", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    cachedApprovals.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an owner that isn't an address, with 400", async () => {
    for (const query of ["", "?owner=", "?owner=nope", "?owner=0x12"]) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That isn't an address." });
    }
    expect(cachedApprovals).not.toHaveBeenCalled();
  });

  it("answers the owner's live approvals, kept by no browser or CDN", async () => {
    cachedApprovals.mockResolvedValue({ approvals: [], truncated: false });
    const res = await get(`?owner=${OWNER}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ approvals: [], truncated: false });
    expect(cachedApprovals).toHaveBeenCalledWith(OWNER);
  });

  it("answers 503 with a sentence to show when the explorer or the RPC fails, kept by no browser or CDN, logging only the error's name", async () => {
    cachedApprovals.mockRejectedValue(new Error("The explorer answered 402."));
    const res = await get(`?owner=${OWNER}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Couldn't load approvals. Try again in a minute." });
    expect(errorSpy).toHaveBeenCalledWith("approvals failed", "Error");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("limits each client to 20 lookups a minute", async () => {
    cachedApprovals.mockResolvedValue({ approvals: [], truncated: false });
    for (let i = 0; i < 20; i++) expect((await get(`?owner=${OWNER}`, "203.0.113.9")).status).toBe(200);
    const res = await get(`?owner=${OWNER}`, "203.0.113.9");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
