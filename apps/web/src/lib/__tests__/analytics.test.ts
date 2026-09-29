import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackEvent } from "../analytics";

// The helper reads window and navigator when it is called, so a test stands in for a browser by stubbing them, and for
// the server by stubbing neither. Nothing here reaches a network.
type Beacon = (url: string, data: Blob) => boolean;
const beacon = vi.fn<Beacon>();
const fetchMock = vi.fn();

function asBrowser({ sendBeacon = true }: { sendBeacon?: boolean } = {}) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", sendBeacon ? { sendBeacon: beacon } : {});
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  beacon.mockReset().mockReturnValue(true);
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackEvent, on the server", () => {
  it("does nothing while rendering: no beacon, no request", () => {
    vi.stubGlobal("fetch", fetchMock);
    expect(typeof window).toBe("undefined");
    trackEvent("proof_share");
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("trackEvent, in a browser with sendBeacon", () => {
  beforeEach(() => asBrowser());

  it("sends { name, props } to /api/event with sendBeacon, and makes no request of its own", async () => {
    trackEvent("inspect_run", { passed: 5, total: 8 });
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, data] = beacon.mock.calls[0]!;
    expect(url).toBe("/api/event");
    expect(data).toBeInstanceOf(Blob);
    expect(data.type).toBe("application/json");
    expect(JSON.parse(await data.text())).toEqual({ name: "inspect_run", props: { passed: 5, total: 8 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends empty props when it is given none", async () => {
    trackEvent("proof_share");
    expect(JSON.parse(await beacon.mock.calls[0]![1].text())).toEqual({ name: "proof_share", props: {} });
  });

  it("falls back to fetch when the browser won't queue the beacon", () => {
    beacon.mockReturnValue(false);
    trackEvent("fix_click", { app: "vault" });
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to fetch when sendBeacon throws", () => {
    beacon.mockImplementation(() => {
      throw new TypeError("Illegal invocation");
    });
    expect(() => trackEvent("fix_click", { app: "vault" })).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("trackEvent, in a browser without sendBeacon", () => {
  beforeEach(() => asBrowser({ sendBeacon: false }));

  it("posts with fetch and keepalive, so the request survives the page going away", () => {
    trackEvent("swap_success", { pair: "USDC-EURC" });
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/event");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(JSON.parse(init.body)).toEqual({ name: "swap_success", props: { pair: "USDC-EURC" } });
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("sends no cookies or credentials of its own choosing, and nothing but the event", () => {
    trackEvent("bridge_success", { from: "Base", to: "Arc" });
    const init = fetchMock.mock.calls[0]![1];
    expect(Object.keys(init).sort()).toEqual(["body", "headers", "keepalive", "method"]);
  });
});

describe("trackEvent never breaks a user action", () => {
  beforeEach(() => asBrowser({ sendBeacon: false }));

  it("swallows a fetch that rejects, without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      expect(() => trackEvent("proof_share")).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("swallows a fetch that throws at once", () => {
    fetchMock.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => trackEvent("proof_share")).not.toThrow();
  });

  it("swallows props that can't be turned into JSON", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => trackEvent("proof_share", loop as unknown as Record<string, string>)).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns nothing", () => {
    expect(trackEvent("proof_share")).toBeUndefined();
  });
});
