import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError, RpcRequestError, TimeoutError, createTransport, type EIP1193RequestFn, type Transport } from "viem";
import { CHAINS } from "@arcos/chain";
import { rpcTransport } from "../rpc-transport";

type Built = ReturnType<ReturnType<typeof rpcTransport>>;
const blockNumber = (transport: Built) => transport.request({ method: "eth_blockNumber" });

/** Records how a promise settles: its value, or the error it rejected with. */
function outcome(p: Promise<unknown>) {
  const o: { settled: unknown } = { settled: null };
  p.then(
    (v) => (o.settled = v),
    (e: unknown) => (o.settled = e),
  );
  return o;
}

describe("rpcTransport", () => {
  it.each(Object.entries(CHAINS))("tries every %s RPC URL in list order, one 3 s attempt each", (_, chain) => {
    const transport = rpcTransport(chain)({ chain });
    expect(transport.config.retryCount).toBe(0);
    const inner = (transport.value?.transports ?? []) as { config: { type: string; timeout?: number; retryCount?: number }; value?: { url?: string } }[];
    expect(inner.map((t) => t.value?.url)).toEqual(chain.rpcUrls.default.http);
    expect(inner.map((t) => [t.config.type, t.config.timeout, t.config.retryCount])).toEqual(chain.rpcUrls.default.http.map(() => ["http", 3_000, 0]));
  });
});

// The four cases the design turns on, with fake endpoints and vitest's fake clock (the transport reads Date.now()).
describe("rpcTransport's cooldown", () => {
  const chain = CHAINS.mainnet;
  const [u0, u1, u2, u3] = chain.rpcUrls.default.http as [string, string, string, string];

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Behaviour = () => Promise<unknown>;
  const answers = (value: unknown): Behaviour => async () => value;
  /** What viem's HTTP transport throws when an endpoint doesn't answer within its 3 s timeout. */
  const hangs = (url: string): Behaviour => () =>
    new Promise((_, reject) => setTimeout(() => reject(new TimeoutError({ body: {}, url })), 3_000));
  const httpStatus = (url: string, status: number): Behaviour => async () => {
    throw new HttpRequestError({ body: {}, status, url });
  };
  const rpcError = (url: string, code: number, message: string): Behaviour => async () => {
    throw new RpcRequestError({ body: {}, error: { code, message }, url });
  };

  /**
   * One fake endpoint per URL, each going through viem's own request pipeline (`createTransport`), as a real one does.
   * `script[url]` lists what its successive calls do, the last one repeating. `tried` records every call, in order.
   */
  function endpoints(script: Record<string, Behaviour[]>) {
    const tried: string[] = [];
    const calls = new Map<string, number>();
    const connect = (url: string): Transport => () => {
      const request = (async () => {
        tried.push(url);
        const n = (calls.get(url) ?? 0) + 1;
        calls.set(url, n);
        const steps = script[url] ?? [answers("0x1")];
        return steps[Math.min(n, steps.length) - 1]!();
      }) as EIP1193RequestFn;
      return createTransport({ key: "fake", name: "Fake endpoint", type: "fake", retryCount: 0, request });
    };
    return { tried, transport: rpcTransport(chain, { connect, now: () => Date.now() })({ chain }) };
  }

  it("1. pays one 3 s timeout for a hung primary, then the next call skips it without waiting", async () => {
    const { tried, transport } = endpoints({ [u0]: [hangs(u0)], [u1]: [answers("0x10")] });
    const first = outcome(blockNumber(transport));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(first.settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.settled).toBe("0x10");
    expect(tried).toEqual([u0, u1]);

    const second = outcome(blockNumber(transport));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.settled).toBe("0x10");
    expect(tried).toEqual([u0, u1, u1]);
  });

  it("2. tries the primary again 60 s after it failed", async () => {
    const { tried, transport } = endpoints({ [u0]: [hangs(u0), answers("0xaa")], [u1]: [answers("0x10")] });
    const first = outcome(blockNumber(transport));
    await vi.advanceTimersByTimeAsync(3_000); // the primary times out at 3 s and cools down until 63 s
    expect(first.settled).toBe("0x10");
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(blockNumber(transport)).resolves.toBe("0x10");
    await vi.advanceTimersByTimeAsync(1);
    await expect(blockNumber(transport)).resolves.toBe("0xaa");
    expect(tried).toEqual([u0, u1, u1, u0]);
  });

  it.each([
    [3, "execution reverted"],
    [-32003, "revert: OutOfFunds"],
    [-32602, "invalid params"],
  ])("3. returns a JSON-RPC error (%i) from the primary at once: no other endpoint, no cooldown", async (code, message) => {
    const { tried, transport } = endpoints({ [u0]: [rpcError(u0, code, message)] });
    await expect(blockNumber(transport)).rejects.toMatchObject({ code });
    await expect(blockNumber(transport)).rejects.toMatchObject({ code });
    expect(tried).toEqual([u0, u0]);
  });

  it("4. tries them all in list order when every endpoint is cooling down, and uses the one that answered again at once", async () => {
    const down = (url: string) => httpStatus(url, 503);
    const { tried, transport } = endpoints({ [u0]: [down(u0)], [u1]: [down(u1)], [u2]: [down(u2), answers("0x10")], [u3]: [down(u3)] });
    await expect(blockNumber(transport)).rejects.toBeInstanceOf(HttpRequestError);
    expect(tried).toEqual([u0, u1, u2, u3]);
    await expect(blockNumber(transport)).resolves.toBe("0x10");
    expect(tried.slice(4)).toEqual([u0, u1, u2]);
    await expect(blockNumber(transport)).resolves.toBe("0x10");
    expect(tried.slice(7)).toEqual([u2]);
  });
});

// The same transport over viem's real HTTP transport, with `fetch` stubbed: what reaches the cooldown logic is what
// viem really throws.
describe("rpcTransport over viem's HTTP transport", () => {
  const chain = CHAINS.mainnet;
  // As `fetch` sees them: viem sends each URL through `new URL()`, which adds the trailing slash.
  const urls = chain.rpcUrls.default.http.map((u) => new URL(u).href);
  const connectTo = () => rpcTransport(chain)({ chain });
  const result = (value: string) => Response.json({ jsonrpc: "2.0", id: 1, result: value });
  /** Never answers; ends only when its signal aborts, as a real fetch does. */
  const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

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
    const tried = stubFetch(async () => result("0x10"));
    await expect(blockNumber(connectTo())).resolves.toBe("0x10");
    expect(tried).toEqual([urls[0]]);
  });

  it("moves on to the next URL, in list order, when one fails", async () => {
    const tried = stubFetch(async (url) => (url === urls[2] ? result("0x10") : new Response("bad gateway", { status: 502 })));
    await expect(blockNumber(connectTo())).resolves.toBe("0x10");
    expect(tried).toEqual(urls.slice(0, 3));
  });

  it("tries each URL exactly once, then gives up, when all of them fail", async () => {
    const tried = stubFetch(async () => new Response("unavailable", { status: 503 }));
    await expect(blockNumber(connectTo())).rejects.toThrow();
    expect(tried).toEqual(urls);
  });

  it("gives up after one 3 s attempt per URL when none of them answers — the worst case for one call", async () => {
    vi.useFakeTimers();
    const tried = stubFetch((_, init) => hang(init));
    const call = outcome(blockNumber(connectTo()));
    await vi.advanceTimersByTimeAsync(urls.length * 3_000 - 1);
    expect(tried).toEqual(urls);
    expect(call.settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBeInstanceOf(TimeoutError);
  });

  it("cuts a hung endpoint off at 3 s, then skips it: the next call doesn't wait for it", async () => {
    vi.useFakeTimers();
    const tried = stubFetch((url, init) => (url === urls[0] ? hang(init) : Promise.resolve(result("0x10"))));
    const transport = connectTo();
    const first = outcome(blockNumber(transport));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(first.settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.settled).toBe("0x10");
    const second = outcome(blockNumber(transport));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.settled).toBe("0x10");
    expect(tried).toEqual([urls[0], urls[1], urls[1]]);
  });

  it("hands a JSON-RPC error straight back from the first URL, which stays in use", async () => {
    const tried = stubFetch(async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x" } }));
    const transport = connectTo();
    await expect(blockNumber(transport)).rejects.toMatchObject({ code: 3 });
    await expect(blockNumber(transport)).rejects.toMatchObject({ code: 3 });
    expect(tried).toEqual([urls[0], urls[0]]);
  });
});
