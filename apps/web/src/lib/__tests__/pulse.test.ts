import { describe, expect, it, vi } from "vitest";
import { PULSE_BLOCKS, PulseRefused, parsePulse, pulseCache, toPulse, type FeeHistoryAnswer, type Pulse } from "../pulse";

const ANSWER: Pulse = { oldestBlock: 100, ratios: [0.1, 0.2] };

/** What toPulse throws for a history, or undefined when it takes it. */
const refusal = (history: FeeHistoryAnswer): unknown => {
  try {
    toPulse(history);
  } catch (e) {
    return e;
  }
  return undefined;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("toPulse", () => {
  it("answers the oldest block as a number and each ratio to 4 decimals", () => {
    expect(toPulse({ oldestBlock: 1234n, gasUsedRatio: [0.123456, 0.32, 0] })).toEqual({
      oldestBlock: 1234,
      ratios: [0.1235, 0.32, 0],
    });
    expect(PULSE_BLOCKS).toBe(1024);
  });

  it("keeps every ratio within 0 and 1", () => {
    expect(toPulse({ oldestBlock: 1n, gasUsedRatio: [-0.5, 1.7, 0.5] }).ratios).toEqual([0, 1, 0.5]);
  });

  // A ratio that isn't a number used to be plotted as 0, which is data nobody measured. Refused, the route answers 503
  // and the browser keeps the last good chart.
  it("refuses a ratio that isn't a finite number, instead of plotting it as 0", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => toPulse({ oldestBlock: 1n, gasUsedRatio: [0.1, bad, 0.2] }), String(bad)).toThrow();
    }
  });

  // The route's log keeps an error's name and nothing else, so a refusal has a name of its own to read apart from an RPC
  // failure, which arrives as a plain Error or a TypeError.
  it("names every refusal PulseRefused", () => {
    const refusals = [
      refusal({ oldestBlock: 1n, gasUsedRatio: [0.1, Number.NaN, 0.2] }),
      refusal({ oldestBlock: 1n, gasUsedRatio: [0.5] }),
      refusal({ oldestBlock: 1n, gasUsedRatio: [] }),
    ];
    for (const e of refusals) {
      expect((e as Error | undefined)?.name).toBe("PulseRefused");
      expect(e).toBeInstanceOf(PulseRefused);
      expect(e).toBeInstanceOf(Error);
    }
  });

  // One ratio, or none, would draw a chart of nothing (a line needs two points), and would replace the last good one.
  it("refuses fewer than 2 ratios, and takes 2", () => {
    expect(() => toPulse({ oldestBlock: 1n, gasUsedRatio: [] })).toThrow();
    expect(() => toPulse({ oldestBlock: 1n, gasUsedRatio: [0.5] })).toThrow();
    expect(toPulse({ oldestBlock: 1n, gasUsedRatio: [0.5, 0.25] })).toEqual({ oldestBlock: 1, ratios: [0.5, 0.25] });
  });
});

describe("parsePulse", () => {
  it("accepts the route's answer", () => {
    expect(parsePulse({ oldestBlock: 5, ratios: [0, 0.5] })).toEqual({ oldestBlock: 5, ratios: [0, 0.5] });
  });

  it("refuses anything else", () => {
    const bad: unknown[] = [
      null,
      "x",
      {},
      { error: "unavailable" },
      { oldestBlock: "5", ratios: [] },
      { oldestBlock: 5.5, ratios: [] },
      { oldestBlock: 5, ratios: ["0.1"] },
      { oldestBlock: 5, ratios: [Number.NaN] },
    ];
    for (const value of bad) expect(() => parsePulse(value)).toThrow();
  });
});

describe("pulseCache", () => {
  it("shares one call between the requests that arrive while it runs", async () => {
    const call = deferred<Pulse>();
    const load = vi.fn(() => call.promise);
    const cache = pulseCache(load, () => 0);
    const a = cache.get();
    const b = cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    call.resolve(ANSWER);
    expect(await a).toBe(ANSWER);
    expect(await b).toBe(ANSWER);
  });

  it("keeps an answer for 60 s after it arrives", async () => {
    let now = 0;
    const load = vi.fn(async () => ANSWER);
    const cache = pulseCache(load, () => now);
    await cache.get();
    now = 59_999;
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    now = 60_000;
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure for 10 s, then asks again", async () => {
    let now = 0;
    const load = vi.fn(async (): Promise<Pulse> => {
      throw new Error("rpc down");
    });
    const cache = pulseCache(load, () => now);
    await expect(cache.get()).rejects.toThrow("rpc down");
    now = 9_999;
    await expect(cache.get()).rejects.toThrow("rpc down");
    expect(load).toHaveBeenCalledTimes(1);
    now = 10_000;
    await expect(cache.get()).rejects.toThrow("rpc down");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
