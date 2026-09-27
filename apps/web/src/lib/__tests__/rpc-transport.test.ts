import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError, RpcRequestError, TimeoutError, createPublicClient, createTransport, type EIP1193RequestFn, type Transport } from "viem";
import { CHAINS } from "@arcos/chain";
import { inspect, viemReader } from "@arcos/inspector";
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

  /** One call's outcome; `options` are the per-request options the endpoint received (a caller's `signal`). */
  type Behaviour = (options?: { signal?: AbortSignal }) => Promise<unknown>;
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
      const request = (async (_: unknown, options?: { signal?: AbortSignal }) => {
        tried.push(url);
        const n = (calls.get(url) ?? 0) + 1;
        calls.set(url, n);
        const steps = script[url] ?? [answers("0x1")];
        return steps[Math.min(n, steps.length) - 1]!(options);
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

  /** Answers `value` after `ms`: a slow endpoint, or one whose answer is still on its way. */
  const slow = (ms: number, value: unknown): Behaviour => () => new Promise((resolve) => setTimeout(() => resolve(value), ms));

  it("5. keeps a cooldown that an answer already on its way can't clear (a slow primary, review probe D1)", async () => {
    const { tried, transport } = endpoints({ [u0]: [hangs(u0), slow(2_900, "0xslow"), answers("0xaa")], [u1]: [answers("0x10")] });
    const a = outcome(blockNumber(transport)); // 0 s: to u0, which hangs
    await vi.advanceTimersByTimeAsync(500);
    const b = outcome(blockNumber(transport)); // 0.5 s: to u0, which answers at 3.4 s
    await vi.advanceTimersByTimeAsync(2_500); // 3 s: a times out, u0 cools down, a goes to u1
    expect(a.settled).toBe("0x10");
    await vi.advanceTimersByTimeAsync(400); // 3.4 s: b's answer, sent before u0 failed, arrives
    expect(b.settled).toBe("0xslow");
    const c = outcome(blockNumber(transport));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.settled).toBe("0x10");
    expect(tried).toEqual([u0, u0, u1, u1]);
  });

  it("6. keeps the cooldown a fast failure set while an earlier request to the same endpoint was in flight (review probe D2)", async () => {
    const { tried, transport } = endpoints({ [u0]: [slow(200, "0xslow"), httpStatus(u0, 503), answers("0xaa")], [u1]: [answers("0x10")] });
    const a = outcome(blockNumber(transport)); // to u0, answering in 200 ms
    const b = outcome(blockNumber(transport)); // to u0, which fails at once: u0 cools down, b goes to u1
    await vi.advanceTimersByTimeAsync(0);
    expect(b.settled).toBe("0x10");
    await vi.advanceTimersByTimeAsync(200);
    expect(a.settled).toBe("0xslow");
    const c = outcome(blockNumber(transport));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.settled).toBe("0x10");
    expect(tried).toEqual([u0, u0, u1, u1]);
  });

  it("7. hands the caller's per-request options (its signal) on to the endpoint", async () => {
    const received: unknown[] = [];
    const { transport } = endpoints({ [u0]: [async (options) => (received.push(options?.signal), "0x10")] });
    const signal = new AbortController().signal;
    await expect(transport.request({ method: "eth_blockNumber" }, { signal })).resolves.toBe("0x10");
    expect(received).toEqual([signal]);
  });

  it("8. neither cools an endpoint down nor asks another when the caller gave up", async () => {
    const waitsForAbort: Behaviour = (options) =>
      new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason)));
    const { tried, transport } = endpoints({ [u0]: [waitsForAbort, answers("0xaa")], [u1]: [answers("0x10")] });
    const caller = new AbortController();
    const a = outcome(transport.request({ method: "eth_blockNumber" }, { signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.settled).toBeInstanceOf(Error);
    expect(tried).toEqual([u0]);
    await expect(blockNumber(transport)).resolves.toBe("0xaa"); // u0 wasn't put on cooldown
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

// Which errors are the node's answer (they come straight back, and the endpoint stays in use) and which are the endpoint
// failing (the next URL is asked, and this one is skipped for 60 s). The rule is rpc-errors.ts's, shared with the
// reader: only a revert or -32602 is an answer, whatever HTTP status carried it.
describe("rpcTransport: which errors skip an endpoint", () => {
  const chain = CHAINS.mainnet;
  const urls = chain.rpcUrls.default.http.map((u) => new URL(u).href);
  const rpcError = (code: number, message: string, status = 200, data?: unknown) => () =>
    Response.json({ jsonrpc: "2.0", id: 1, error: { code, message, ...(data === undefined ? {} : { data }) } }, { status });
  const result = (value: string) => Response.json({ jsonrpc: "2.0", id: 1, result: value });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The primary answers with `respond`; every other URL answers 0x10. */
  function primaryAnswers(respond: () => Response) {
    const tried: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      tried.push(String(input));
      return String(input) === urls[0] ? respond() : result("0x10");
    });
    return { tried, transport: rpcTransport(chain)({ chain }) };
  }

  it.each([
    ["code 3, execution reverted", rpcError(3, "execution reverted", 200, "0x")],
    ["-32000 execution reverted", rpcError(-32000, "execution reverted")],
    ["-32003 revert: OutOfFunds (Arc)", rpcError(-32003, "revert: OutOfFunds")],
    ["-32602 invalid params", rpcError(-32602, "invalid argument 0: hex string has length 38")],
    ["a revert carried by an HTTP 500", rpcError(3, "execution reverted", 500, "0x")],
  ])("%s is the node's answer: it comes straight back, and the endpoint stays in use", async (_, respond) => {
    const { tried, transport } = primaryAnswers(respond);
    await expect(blockNumber(transport)).rejects.toThrow();
    await expect(blockNumber(transport)).rejects.toThrow();
    expect(tried).toEqual([urls[0], urls[0]]);
  });

  it.each([
    ["-32603 internal error", rpcError(-32603, "internal error")],
    ["-32603 in an HTTP 503 (review probe I-1)", rpcError(-32603, "upstream unavailable", 503)],
    ["-32005 in an HTTP 429 (review probe I-2)", rpcError(-32005, "limit exceeded", 429)],
    ["-32007 request limit reached", rpcError(-32007, "10/second request limit reached")],
    ["-32000 without revert", rpcError(-32000, "header not found")],
    ["-32601 method not found", rpcError(-32601, "the method eth_call does not exist/is not available")],
    ["-1 unknown error", rpcError(-1, "unknown error")],
    ["an HTTP 502 with no JSON-RPC body", () => new Response("bad gateway", { status: 502 })],
  ])("%s is the endpoint failing: the next URL answers, and this one is skipped", async (_, respond) => {
    const { tried, transport } = primaryAnswers(respond);
    await expect(blockNumber(transport)).resolves.toBe("0x10");
    await expect(blockNumber(transport)).resolves.toBe("0x10");
    expect(tried).toEqual([urls[0], urls[1], urls[1]]);
  });
});

// The review's probe I-1 end to end: owner() answered with an HTTP 503 carrying -32603 must never become "No owner
// function". With a healthy URL behind it, the owner is read from there; with none, the owner is unknown and the report
// is degraded.
describe("an inspection over rpcTransport when owner() gets a gateway error", () => {
  const chain = CHAINS.mainnet;
  const urls = chain.rpcUrls.default.http.map((u) => new URL(u).href);
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const OWNER = "0x3333333333333333333333333333333333333333";
  const OWNER_SELECTOR = "0x8da5cb5b";
  const reply = (body: object, status = 200) => Response.json({ jsonrpc: "2.0", id: 1, ...body }, { status });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A plain token: transfer in its dispatcher, no proxy slots, every call reverting except owner(). */
  function node(owner: (url: string) => Response) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body)) as { method: string; params: [Record<string, string>, ...unknown[]] };
      if (method === "eth_getCode") return reply({ result: String(params[0]).toLowerCase() === TOKEN ? "0x63a9059cbb00" : "0x" });
      if (method === "eth_getStorageAt") return reply({ result: `0x${"0".repeat(64)}` });
      if (method === "eth_blockNumber") return reply({ result: "0x1" });
      if (method === "eth_call" && (params[0].data ?? params[0].input ?? "").startsWith(OWNER_SELECTOR)) return owner(String(input));
      return reply({ error: { code: 3, message: "execution reverted", data: "0x" } });
    });
    return inspect({
      address: TOKEN, network: "mainnet", reader: viemReader(createPublicClient({ chain, transport: rpcTransport(chain) })),
      explorer: null, dex: null, knownLockers: [], explorerBase: "https://explorer.test",
    });
  }
  const gatewayError = () => reply({ error: { code: -32603, message: "upstream unavailable" } }, 503);

  it("reads the owner from the next URL when only the primary fails", async () => {
    const r = await node((url) => (url === urls[0] ? gatewayError() : reply({ result: `0x${OWNER.slice(2).padStart(64, "0")}` })));
    expect(r.findings.find((f) => f.id === "ownership")).toMatchObject({ status: "warn", title: "Owned by a wallet" });
  });

  it("says the owner is unknown, and the report is degraded, when no URL answers", async () => {
    const r = await node(() => gatewayError());
    expect(r.findings.find((f) => f.id === "ownership")).toMatchObject({ status: "unknown", title: "Couldn't read the owner" });
    expect(r.degraded).toBe(true);
  });
});
