import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@arcos/inspector";

// A marker module that throws outside a server build; the routes' shared module (lib/inspect-route.ts) carries it.
vi.mock("server-only", () => ({}));

// The real module is server-only and opens RPC clients when it loads; these routes only need its answers.
const { cachedInspection, requestHeaders } = vi.hoisted(() => ({
  cachedInspection: vi.fn<(address: string, chain?: string) => Promise<Report>>(),
  requestHeaders: { current: new Headers() },
}));
vi.mock("@/lib/inspect-server", () => ({ cachedInspection }));
// The proof page and its card read the client from the request's headers (for the limiter off Arc).
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

import nextConfig from "../../../next.config";
import { GET as arcApi } from "@/app/api/inspect/[target]/route";
import { GET as chainApi } from "@/app/api/inspect/[target]/[address]/route";
import { GET as arcBadge } from "@/app/badge/[target]/route";
import { GET as chainBadge } from "@/app/badge/[target]/[address]/route";
import ChainOgImage from "@/app/t/[target]/[address]/opengraph-image";
import ChainProofPage, { generateMetadata as chainMetadata } from "@/app/t/[target]/[address]/page";

const ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const report = (over: Partial<Report> = {}): Report => ({
  address: ADDRESS,
  network: "mainnet",
  chain: "base",
  chainId: 8453,
  token: { name: "USD Coin", symbol: "USDC", decimals: 6, totalSupply: "1" },
  findings: [],
  passed: 0,
  total: 0,
  counts: { pass: 0, warn: 0, fail: 0, unknown: 0 },
  explorerReachable: true,
  degraded: false,
  blockNumber: "1",
  generatedAt: "2026-11-27T00:00:00.000Z",
  ...over,
});

let client = 0;
/** A fresh client address for each call that wants one: the limiters keep their counts per client, per process. */
const freshClient = () => `203.0.113.${++client}`;
const request = (path: string, ip = freshClient()) => new Request(`https://4rcos.test${path}`, { headers: { "x-forwarded-for": ip } });
const chainParams = (target: string, address = ADDRESS) => ({ params: Promise.resolve({ target, address }) });
/** A page's element, rendered down to plain elements: its components here are plain functions of their props. */
type El = { type: unknown; props: Record<string, unknown> };
const rendered = (el: unknown): unknown =>
  typeof el === "object" && el !== null && typeof (el as El).type === "function" ? rendered(((el as El).type as (p: unknown) => unknown)((el as El).props)) : el;
/** The page as JSON text, to look for what it says and links. */
const pageText = async (page: Promise<unknown>) => JSON.stringify(rendered(await page));

/** The digest Next's notFound() and permanentRedirect() throw with. */
const thrown = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return String((e as { digest?: unknown }).digest);
  }
  return "nothing thrown";
};

beforeEach(() => {
  cachedInspection.mockReset();
  cachedInspection.mockResolvedValue(report());
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  requestHeaders.current = new Headers({ "x-forwarded-for": freshClient() });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the chain routes while NEXT_PUBLIC_INSPECT_CHAINS is unset: nothing changes for anyone", () => {
  it.each(["base", "ethereum", "arbitrum", "optimism", "polygon"])("answers 404 for /api/inspect/%s/<address>, /badge and the card, and inspects nothing", async (slug) => {
    const api = await chainApi(request(`/api/inspect/${slug}/${ADDRESS}`), chainParams(slug));
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "Not available on this network." });
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect((await chainBadge(request(`/badge/${slug}/${ADDRESS}`), chainParams(slug))).status).toBe(404);
    expect((await ChainOgImage(chainParams(slug))).status).toBe(404);
    expect(cachedInspection).not.toHaveBeenCalled();
  });

  it("answers 404 for the proof page, metadata and body", async () => {
    expect(await thrown(() => ChainProofPage(chainParams("base")))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect((await chainMetadata(chainParams("base"))).title).toBe("Page not found — ArcOS");
    expect(cachedInspection).not.toHaveBeenCalled();
  });
});

describe("the chain routes with a chain switched on", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base"));

  it("inspects on that chain, and keeps its report apart from Arc's of the same address", async () => {
    const res = await chainApi(request(`/api/inspect/base/${ADDRESS}`), chainParams("base"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chain: "base", chainId: 8453 });
    expect(cachedInspection).toHaveBeenCalledWith(ADDRESS, "base");
    await arcApi(request(`/api/inspect/${ADDRESS}`), { params: Promise.resolve({ target: ADDRESS }) });
    expect(cachedInspection).toHaveBeenLastCalledWith(ADDRESS, "arc");
  });

  it("answers 404 for every chain the flag doesn't name, and for a slug spelled otherwise", async () => {
    for (const slug of ["ethereum", "arbitrum", "optimism", "BASE", "Base", "polygon", "arc-testnet"]) {
      expect((await chainApi(request(`/api/inspect/${slug}/${ADDRESS}`), chainParams(slug))).status, slug).toBe(404);
    }
    expect(cachedInspection).not.toHaveBeenCalled();
  });

  it("answers 404 on the testnet site, whatever the flag says", async () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "ethereum,base,arbitrum,optimism");
    expect((await chainApi(request(`/api/inspect/base/${ADDRESS}`), chainParams("base"))).status).toBe(404);
    expect((await chainBadge(request(`/badge/base/${ADDRESS}`), chainParams("base"))).status).toBe(404);
    expect(await thrown(() => ChainProofPage(chainParams("base")))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(cachedInspection).not.toHaveBeenCalled();
  });

  it("answers 400 for what isn't an address, a neutral badge, and a 404 page, inspecting nothing", async () => {
    const res = await chainApi(request("/api/inspect/base/0x123"), chainParams("base", "0x123"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That isn't an address." });
    const badge = await chainBadge(request("/badge/base/0x123"), chainParams("base", "0x123"));
    expect(badge.status).toBe(200);
    expect(await badge.text()).toContain("not inspected");
    expect(await thrown(() => ChainProofPage(chainParams("base", "nope")))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(cachedInspection).not.toHaveBeenCalled();
  });

  it("keeps a report as long as Arc's: 5 minutes clean, 30 seconds degraded, 5 seconds for a failed badge or card", async () => {
    const cacheControl = async (get: () => Promise<Response>) => {
      const res = await get();
      await res.arrayBuffer(); // the card renders as its body is read
      return res.headers.get("cache-control");
    };
    const surfaces = [
      () => chainApi(request(`/api/inspect/base/${ADDRESS}`), chainParams("base")),
      () => chainBadge(request(`/badge/base/${ADDRESS}`), chainParams("base")),
      () => ChainOgImage(chainParams("base")),
    ];
    for (const get of surfaces) expect(await cacheControl(get)).toBe("public, s-maxage=300, stale-while-revalidate=600");
    cachedInspection.mockResolvedValue(report({ degraded: true }));
    for (const get of surfaces) expect(await cacheControl(get)).toBe("public, s-maxage=30");
    cachedInspection.mockRejectedValue(Object.assign(new Error("x"), { name: "InspectorBusy" }));
    for (const get of surfaces.slice(1)) expect(await cacheControl(get)).toBe("public, s-maxage=5");
    expect((await surfaces[0]!()).status).toBe(503);
  });

  it("names the chain in the proof page's title and description, and in the badge", async () => {
    const meta = await chainMetadata(chainParams("base"));
    expect(meta.title).toBe("USDC on Base — 0 of 0 checks pass");
    expect(meta.description).toBe("An automated reading of this token's contract on Base. Not investment advice.");
    const svg = await (await chainBadge(request(`/badge/base/${ADDRESS}`), chainParams("base"))).text();
    expect(svg).toContain(">USDC - Base<");
    expect(svg).toContain("<title>USDC - Base: 0/0 pass");
  });

  it("links the chain's Blockscout and Basescan beside the address, and opens the Inspector on the chain", async () => {
    const page = await pageText(ChainProofPage(chainParams("base")));
    expect(page).toContain(`https://base.blockscout.com/token/${ADDRESS}`);
    expect(page).toContain(`https://basescan.org/token/${ADDRESS}`);
    expect(page).toContain("Open on Basescan");
    expect(page).toContain(`/#app:inspector?chain=base&token=${ADDRESS}`);
  });

  it("logs a failure with the chain's slug and the error's name only, never its message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      cachedInspection.mockRejectedValue(new TypeError("fetch failed: https://base-mainnet.g.alchemy.com/v2"));
      expect((await chainApi(request(`/api/inspect/base/${ADDRESS}`), chainParams("base"))).status).toBe(502);
      await chainBadge(request(`/badge/base/${ADDRESS}`), chainParams("base"));
      await (await ChainOgImage(chainParams("base"))).arrayBuffer();
      await ChainProofPage(chainParams("base"));
      expect(errorSpy.mock.calls).toEqual([
        ["inspect failed", "base", "TypeError"],
        ["badge inspect failed", "base", "TypeError"],
        ["og inspect failed", "base", "TypeError"],
        ["proof page inspect failed", "base", "TypeError"],
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("says why the explorer wasn't asked, when it wasn't, and never sends the visitor to the window for a fuller reading", async () => {
    const reason = "The explorer wasn't asked: this server has used up today's explorer reads for chains other than Arc.";
    cachedInspection.mockResolvedValue(report({ explorerReachable: false, explorerSkipped: reason }));
    expect(await pageText(ChainProofPage(chainParams("base")))).toContain(`${reason} Some checks are unknown here.`);
    cachedInspection.mockResolvedValue(report({ explorerReachable: false }));
    const page = await pageText(ChainProofPage(chainParams("base")));
    expect(page).toContain("The explorer didn't answer this server, so some checks are unknown here.");
    expect(page).not.toContain("Open the token in ArcOS for the full reading");
  });
});

describe("Arc's slug in the chain form", () => {
  it("is redirected for good, before any route runs: /t, /badge and /api/inspect", async () => {
    expect(await nextConfig.redirects!()).toEqual([
      { source: "/t/arc/:address", destination: "/t/:address", permanent: true },
      { source: "/badge/arc/:address", destination: "/badge/:address", permanent: true },
      { source: "/api/inspect/arc/:address", destination: "/api/inspect/:address", permanent: true },
    ]);
  });

  it("is redirected by the page itself too, with a 308, and never inspected as a chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "ethereum,base,arbitrum,optimism");
    expect(await thrown(() => ChainProofPage(chainParams("arc")))).toBe(`NEXT_REDIRECT;replace;/t/${ADDRESS};308;`);
    expect(await thrown(() => chainMetadata(chainParams("arc")))).toBe(`NEXT_REDIRECT;replace;/t/${ADDRESS};308;`);
    // The handlers never take "arc" for a chain: next.config.ts sends those URLs to Arc's own routes first.
    expect((await chainApi(request(`/api/inspect/arc/${ADDRESS}`), chainParams("arc"))).status).toBe(404);
    expect(cachedInspection).not.toHaveBeenCalled();
  });
});

describe("the limiters", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_INSPECT_CHAINS", "base"));

  it("lets a client have 30 badges a minute off Arc, then answers 429 with a neutral badge kept nowhere", async () => {
    const ip = freshClient();
    for (let i = 0; i < 30; i++) expect((await chainBadge(request(`/badge/base/${ADDRESS}`, ip), chainParams("base"))).status, `call ${i + 1}`).toBe(200);
    const refused = await chainBadge(request(`/badge/base/${ADDRESS}`, ip), chainParams("base"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.text()).toContain("not inspected");
    expect(cachedInspection).toHaveBeenCalledTimes(30);
    // Another client still gets its own.
    expect((await chainBadge(request(`/badge/base/${ADDRESS}`), chainParams("base"))).status).toBe(200);
  });

  it("never limits Arc's badge, as before", async () => {
    const ip = freshClient();
    for (let i = 0; i < 35; i++) expect((await arcBadge(request(`/badge/${ADDRESS}`, ip), { params: Promise.resolve({ target: ADDRESS }) })).status).toBe(200);
  });

  it("shares the page limiter between the proof page, its card and the badge, and words a refusal without inspecting", async () => {
    const ip = freshClient();
    requestHeaders.current = new Headers({ "x-forwarded-for": ip });
    for (let i = 0; i < 30; i++) await chainBadge(request(`/badge/base/${ADDRESS}`, ip), chainParams("base"));
    const calls = cachedInspection.mock.calls.length;
    const page = (await ChainProofPage(chainParams("base"))) as { props: { message?: string } };
    expect(page.props.message).toBe("Too many requests from here. Try again in a minute.");
    expect((await chainMetadata(chainParams("base"))).title).toBe("Too many requests — ArcOS");
    const card = await ChainOgImage(chainParams("base"));
    expect(card.status).toBe(429);
    expect(card.headers.get("cache-control")).toBe("no-store");
    expect(cachedInspection.mock.calls.length).toBe(calls);
  });

  it("keeps /api/inspect at 30 a minute per client, Arc and the chains together", async () => {
    const ip = freshClient();
    for (let i = 0; i < 15; i++) await arcApi(request(`/api/inspect/${ADDRESS}`, ip), { params: Promise.resolve({ target: ADDRESS }) });
    for (let i = 0; i < 15; i++) expect((await chainApi(request(`/api/inspect/base/${ADDRESS}`, ip), chainParams("base"))).status).toBe(200);
    const refused = await chainApi(request(`/api/inspect/base/${ADDRESS}`, ip), chainParams("base"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Too many requests. Try again shortly." });
    expect((await arcApi(request(`/api/inspect/${ADDRESS}`, ip), { params: Promise.resolve({ target: ADDRESS }) })).status).toBe(429);
  });

  it("takes no turn for a chain this site doesn't read, nor for what isn't an address", async () => {
    const ip = freshClient();
    for (let i = 0; i < 40; i++) {
      await chainBadge(request(`/badge/polygon/${ADDRESS}`, ip), chainParams("polygon"));
      await chainBadge(request("/badge/base/0x123", ip), chainParams("base", "0x123"));
    }
    expect((await chainBadge(request(`/badge/base/${ADDRESS}`, ip), chainParams("base"))).status).toBe(200);
  });
});
