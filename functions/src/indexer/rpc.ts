import { createPublicClient, http, type Hex, type Transport } from "viem";
import type { Address } from "@arcos/chain";
import type { RawLog } from "./events";

/** What the indexer asks of the chain: the finalized head, and the logs of a window. */
export interface LogChain {
  /** The `finalized` block's number. Arc's `finalized` is `latest` or one behind (F8), so nothing past it can reorg. */
  head(): Promise<number>;
  /** One eth_getLogs over [from, to], inclusive, for the addresses and any of the topic0s. */
  logs(filter: { addresses: readonly Address[]; topic0s: readonly Hex[]; from: number; to: number }): Promise<RawLog[]>;
}

/** The node refused a window as too wide (-32012) or too full (-32602, over 20,000 results). */
export class RangeRefused extends Error {
  constructor(
    /** The width the node suggested ("retry with the range A-B"), when it named one. */
    readonly suggested?: number,
  ) {
    super("The node refused the block range.");
    this.name = "RangeRefused";
  }
}

/** The node kept answering -32005 after every retry. */
export class RateLimited extends Error {
  constructor() {
    super("The node kept rate-limiting the indexer.");
    this.name = "RateLimited";
  }
}

type Link = { code?: unknown; details?: unknown; message?: unknown; shortMessage?: unknown; status?: unknown; cause?: unknown };

/** The JSON-RPC code and the node's own words, from anywhere in an error's cause chain (viem wraps them). */
export function rpcError(e: unknown): { code: number | null; text: string } {
  let code: number | null = null;
  const texts: string[] = [];
  for (let link = e as Link | undefined, depth = 0; typeof link === "object" && link !== null && depth < 16; link = link.cause as Link, depth++) {
    if (code === null && typeof link.code === "number") code = link.code;
    if (link.status === 429 && code === null) code = -32005;
    for (const text of [link.details, link.shortMessage, link.message]) if (typeof text === "string") texts.push(text);
  }
  return { code, text: texts.join(" | ") };
}

const RANGE_TEXT = /range too large|max allowed range|exceeds max results|block range/i;
const SUGGESTED = /retry with the range (\d+)\s*-\s*(\d+)/i;

/** -32012, or a -32602 about the range or the result count: the window must shrink. Null for anything else. */
export function rangeRefusal(e: unknown): RangeRefused | null {
  const { code, text } = rpcError(e);
  if (code !== -32012 && !(code === -32602 && RANGE_TEXT.test(text))) return null;
  const match = SUGGESTED.exec(text);
  return new RangeRefused(match ? Number(match[2]) - Number(match[1]) + 1 : undefined);
}

export const isRateLimit = (e: unknown): boolean => {
  const { code, text } = rpcError(e);
  return code === -32005 || /rate limit/i.test(text);
};

/** The gap between two calls (F7: ten 10,000-block calls 400 ms apart drew no -32005). */
export const CALL_GAP_MS = 400;
/** How many times a -32005 is retried, waiting 1.5 s, 3 s, 4.5 s, then 6 s. */
export const RATE_RETRIES = 4;

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** Runs calls one at a time, at least `gap` ms apart, and retries one the node rate-limited (-32005), backing off. */
export function pacer(clock: Clock = realClock, gap = CALL_GAP_MS): <T>(call: () => Promise<T>) => Promise<T> {
  let next = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const slot = async () => {
    const now = clock.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await clock.sleep(at - now);
  };
  return <T>(call: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await slot();
        try {
          return await call();
        } catch (e) {
          if (!isRateLimit(e)) throw e;
          if (attempt >= RATE_RETRIES) throw new RateLimited();
          await clock.sleep(1_500 * (attempt + 1));
        }
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

/** One HTTP attempt may take this long: a 10,000-block query of a busy range answers in a second or two. */
const ATTEMPT_MS = 20_000;

const hex = (n: number): Hex => `0x${n.toString(16)}`;

/**
 * The indexer's chain, over one RPC endpoint and the pacer. One endpoint on purpose: the caps it was measured against
 * (F5-F7) are rpc.mainnet.arc.io's, and another provider may refuse a 10,000-block range in its own words. A failure ends
 * the run; the next minute's run repeats the window.
 */
export function rpcLogChain(url: string, options: { clock?: Clock; transport?: Transport } = {}): LogChain {
  const client = createPublicClient({ transport: options.transport ?? http(url, { retryCount: 0, timeout: ATTEMPT_MS }) });
  const paced = pacer(options.clock);
  const request = client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  return {
    head: async () => {
      const block = (await paced(() => request({ method: "eth_getBlockByNumber", params: ["finalized", false] }))) as { number?: Hex } | null;
      if (!block?.number) throw new Error("The node has no finalized block.");
      return Number(BigInt(block.number));
    },
    logs: async ({ addresses, topic0s, from, to }) => {
      try {
        return (await paced(() =>
          request({ method: "eth_getLogs", params: [{ address: addresses, topics: [topic0s], fromBlock: hex(from), toBlock: hex(to) }] }),
        )) as RawLog[];
      } catch (e) {
        throw rangeRefusal(e) ?? e;
      }
    },
  };
}

