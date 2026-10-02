import { describe, expect, it } from "vitest";
import { custom, type EIP1193RequestFn } from "viem";
import { MAX_WINDOW } from "../windows";
import { CALL_GAP_MS, RangeRefused, RateLimited, isRateLimit, pacer, rangeRefusal, rpcLogChain, type Clock } from "../rpc";

/** A clock that only moves when something sleeps on it, so pacing is measured, not waited for. */
function fakeClock(): Clock & { slept: number[] } {
  let t = 1_000_000;
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } };
}

type Call = { method: string; params?: unknown };
/** A fake node: answers each request with `answer`, or fails it with the JSON-RPC error `answer` throws. */
function fakeNode(answer: (call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const transport = custom(
    {
      request: (async (call: Call) => {
        calls.push(call);
        return answer(call, calls.length);
      }) as unknown as EIP1193RequestFn,
    },
    { retryCount: 0 },
  );
  return { calls, transport };
}
const rpcFailure = (code: number, message: string) => Object.assign(new Error(message), { code });

describe("rangeRefusal", () => {
  it("reads -32012, Arc's 'requested range too large' (F5)", () => {
    expect(rangeRefusal(rpcFailure(-32012, "requested range too large"))).toBeInstanceOf(RangeRefused);
  });

  it("reads -32602 over 20,000 results, with the width the node suggests", () => {
    const refusal = rangeRefusal(
      rpcFailure(-32602, "request exceeded max allowed range: query exceeds max results 20000, retry with the range 23822428-23826851"),
    );
    expect(refusal?.suggested).toBe(4_424);
  });

  it("leaves any other error alone: a plain -32602, a rate limit, a timeout", () => {
    expect(rangeRefusal(rpcFailure(-32602, "invalid argument 0: hex string without 0x prefix"))).toBeNull();
    expect(rangeRefusal(rpcFailure(-32005, "rate limit exceeded"))).toBeNull();
    expect(rangeRefusal(new Error("The request took too long to respond."))).toBeNull();
  });
});

describe("pacer", () => {
  it("spaces calls at least 400 ms apart, one at a time, in order", async () => {
    const clock = fakeClock();
    const paced = pacer(clock);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => paced(async () => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(clock.slept).toEqual([CALL_GAP_MS, CALL_GAP_MS]);
  });

  it("retries a -32005 with a growing back-off, then gives up with RateLimited", async () => {
    const clock = fakeClock();
    const paced = pacer(clock);
    let tries = 0;
    const flaky = () => {
      tries++;
      return tries < 3 ? Promise.reject(rpcFailure(-32005, "rate limit exceeded")) : Promise.resolve("ok");
    };
    await expect(paced(flaky)).resolves.toBe("ok");
    expect(clock.slept.filter((ms) => ms >= 1_500)).toEqual([1_500, 3_000]);

    const always = () => Promise.reject(rpcFailure(-32005, "rate limit exceeded"));
    await expect(paced(always)).rejects.toBeInstanceOf(RateLimited);
  });

  it("passes any other failure straight through, and keeps going after it", async () => {
    const paced = pacer(fakeClock());
    await expect(paced(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(paced(async () => "next")).resolves.toBe("next");
  });

  it("calls an HTTP 429 a rate limit too", () => {
    expect(isRateLimit(Object.assign(new Error("Too Many Requests"), { status: 429 }))).toBe(true);
  });
});

describe("rpcLogChain", () => {
  const filter = { addresses: ["0x8366a39CC670B4001A1121B8F6A443A643e40951" as const], topic0s: ["0xdd466e67" as const], from: 100, to: 100 + MAX_WINDOW - 1 };

  it("asks for the finalized block, and for one window of logs with every address and topic0 in one filter", async () => {
    const node = fakeNode((call) => (call.method === "eth_getBlockByNumber" ? { number: "0x16bacf2" } : []));
    const chain = rpcLogChain("https://rpc.test", { clock: fakeClock(), transport: node.transport });
    expect(await chain.head()).toBe(0x16bacf2);
    expect(await chain.logs(filter)).toEqual([]);
    expect(node.calls).toEqual([
      { method: "eth_getBlockByNumber", params: ["finalized", false] },
      { method: "eth_getLogs", params: [{ address: filter.addresses, topics: [filter.topic0s], fromBlock: "0x64", toBlock: "0x2773" }] },
    ]);
  });

  it("turns the node's range refusal into RangeRefused, through viem's error wrapping", async () => {
    const node = fakeNode(() => {
      throw rpcFailure(-32602, "query exceeds max results 20000, retry with the range 100-2099");
    });
    const chain = rpcLogChain("https://rpc.test", { clock: fakeClock(), transport: node.transport });
    await expect(chain.logs(filter)).rejects.toMatchObject({ name: "RangeRefused", suggested: 2_000 });
  });

  it("fails when the node has no finalized block", async () => {
    const node = fakeNode(() => null);
    await expect(rpcLogChain("https://rpc.test", { clock: fakeClock(), transport: node.transport }).head()).rejects.toThrow(/finalized/);
  });
});
