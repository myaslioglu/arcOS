import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAINS } from "@arcos/chain";
import { rpcTransport } from "../rpc-transport";

describe("rpcTransport", () => {
  it.each(Object.entries(CHAINS))("falls back over every %s RPC URL, in list order, one 8 s attempt each", (_, chain) => {
    const transport = rpcTransport(chain)({ chain });
    expect(transport.config.type).toBe("fallback");
    expect(transport.config.retryCount).toBe(0);
    const inner = (transport.value?.transports ?? []) as { config: { type: string; timeout?: number; retryCount?: number }; value?: { url?: string } }[];
    expect(inner.map((t) => t.value?.url)).toEqual(chain.rpcUrls.default.http);
    expect(inner.map((t) => [t.config.type, t.config.timeout, t.config.retryCount])).toEqual(chain.rpcUrls.default.http.map(() => ["http", 8_000, 0]));
  });
});

describe("a call over rpcTransport", () => {
  const chain = CHAINS.mainnet;
  // As `fetch` sees them: viem sends each URL through `new URL()`, which adds the trailing slash.
  const urls = chain.rpcUrls.default.http.map((u) => new URL(u).href);
  const blockNumber = () => rpcTransport(chain)({ chain }).request({ method: "eth_blockNumber" });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Stubs `fetch`, recording which URL each request went to; `answer` gets the URL and the request's options. */
  const stubFetch = (answer: (url: string, init: RequestInit) => Promise<Response>) => {
    const tried: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit) => {
      tried.push(String(input));
      return answer(String(input), init);
    });
    return tried;
  };

  it("keeps the first URL primary: a healthy one answers alone", async () => {
    const tried = stubFetch(async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x10" }));
    await expect(blockNumber()).resolves.toBe("0x10");
    expect(tried).toEqual([urls[0]]);
  });

  it("moves on to the next URL, in list order, when one fails", async () => {
    const tried = stubFetch(async (url) =>
      url === urls[2] ? Response.json({ jsonrpc: "2.0", id: 1, result: "0x10" }) : new Response("bad gateway", { status: 502 }),
    );
    await expect(blockNumber()).resolves.toBe("0x10");
    expect(tried).toEqual(urls.slice(0, 3));
  });

  it("tries each URL exactly once, then gives up, when all of them fail", async () => {
    const tried = stubFetch(async () => new Response("unavailable", { status: 503 }));
    await expect(blockNumber()).rejects.toThrow();
    expect(tried).toEqual(urls);
  });

  it("gives up after one 8 s attempt per URL when none of them answers — the documented worst case", async () => {
    vi.useFakeTimers();
    const tried = stubFetch(
      (_, init) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    let outcome: string | null = null;
    const call = blockNumber().then(() => "answered", () => "gave up");
    void call.then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(urls.length * 8_000 - 1);
    expect(tried).toEqual(urls);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await call).toBe("gave up");
  });
});
