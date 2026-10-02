import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerUnavailable, blockscoutSource } from "../explorer";
import { inspect } from "../inspect";
import { CallReverted, type ChainReader } from "../types";
import { explorerFetch } from "../explorer-fetch";

const API = "https://explorer.test/api/v2";
const TOKEN = "0x1111111111111111111111111111111111111111";

/** One turn a second, the first at once: the web app's per-process pacer at its slowest, kept here without it. */
function oneASecond(): () => Promise<void> {
  let next = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + 1_000;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  };
}

/** A fetch that records what it was asked for and answers every request with an empty JSON object. */
function recordingFetch() {
  const sent: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return Response.json({});
  }) as typeof fetch;
  return { sent, fetchFn };
}

/** A fetch that never answers: it only ever ends by its signal aborting, the way a real fetch does. */
const hangingFetch = ((_: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;

/** Records how a promise settles: the answer, or the name of the error it rejected with. */
function outcome(p: Promise<unknown>) {
  const o: { settled: string | null } = { settled: null };
  p.then(
    () => (o.settled = "answered"),
    (e: unknown) => (o.settled = e instanceof Error || e instanceof DOMException ? e.name : String(e)),
  );
  return o;
}

describe("explorerFetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Node runs AbortSignal.timeout on an internal timer that fake timers can't reach; this stand-in runs on setTimeout.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const timer = new AbortController();
      setTimeout(() => timer.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
      return timer.signal;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("gives every request its own 8 s timeout", async () => {
    const request = outcome(explorerFetch(async () => {}, new AbortController().signal, hangingFetch)(`${API}/tokens/${TOKEN}`));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(request.settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.settled).toBe("TimeoutError");
    expect(AbortSignal.timeout).toHaveBeenCalledWith(8_000);
  });

  it("still ends a request when the caller's own signal aborts", async () => {
    const caller = new AbortController();
    const request = outcome(explorerFetch(async () => {}, new AbortController().signal, hangingFetch)(`${API}/tokens/${TOKEN}`, { signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(request.settled).toBe("AbortError");
  });

  it("ends a request in flight when its inspection gives up", async () => {
    const inspection = new AbortController();
    const request = outcome(explorerFetch(async () => {}, inspection.signal, hangingFetch)(`${API}/tokens/${TOKEN}`));
    await vi.advanceTimersByTimeAsync(0);
    inspection.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(request.settled).toBe("AbortError");
  });

  it("sends nothing once its inspection has given up, not even a request already waiting for its turn", async () => {
    const { sent, fetchFn } = recordingFetch();
    const inspection = new AbortController();
    const fetchFor = explorerFetch(oneASecond(), inspection.signal, fetchFn);
    const first = outcome(fetchFor(`${API}/tokens/${TOKEN}`));
    const second = outcome(fetchFor(`${API}/tokens/${TOKEN}/holders`)); // one a second: this one waits its turn
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([`${API}/tokens/${TOKEN}`]);
    inspection.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([`${API}/tokens/${TOKEN}`]);
    expect([first.settled, second.settled]).toEqual(["answered", "AbortError"]);
  });

  it("doesn't even wait for a turn once its inspection has given up", async () => {
    const { sent, fetchFn } = recordingFetch();
    const turn = vi.fn(async () => {});
    const inspection = new AbortController();
    inspection.abort();
    await expect(explorerFetch(turn, inspection.signal, fetchFn)(`${API}/tokens/${TOKEN}`)).rejects.toMatchObject({ name: "AbortError" });
    expect(turn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

describe("an inspection whose explorer requests were cut off", () => {
  /** A plain token: code with an ERC-20 transfer selector, no proxy slots, every call reverting. */
  const reader: ChainReader = {
    getCode: async () => "0x63a9059cbb00",
    getStorageAt: async () => null,
    read: async () => {
      throw new CallReverted();
    },
    blockNumber: async () => 1n,
  };

  it("reads its explorer checks as unknown and itself as degraded, and still produces a report", async () => {
    const { sent, fetchFn } = recordingFetch();
    const inspection = new AbortController();
    inspection.abort();
    const explorer = blockscoutSource(API, explorerFetch(async () => {}, inspection.signal, fetchFn));
    await expect(explorer.token(TOKEN)).rejects.toBeInstanceOf(ExplorerUnavailable);

    const r = await inspect({ address: TOKEN, network: "testnet", reader, explorer, dex: null, knownLockers: [], explorerBase: "https://explorer.test" });
    expect(sent).toEqual([]);
    expect(r.explorerReachable).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.findings.filter((f) => f.id === "verified" || f.id === "holders").map((f) => f.status)).toEqual(["unknown", "unknown"]);
  });
});
