import "server-only";
import { activeChain, type Address } from "@arcos/chain";
import { inspect, type Report } from "@arcos/inspector";
import { withDeadline } from "./deadline";
import { explorerFetch } from "./explorer-fetch";
import { inspectInput, proExplorerApi } from "./inspect-input";
import { processGlobal } from "./process-global";
import { inFlightGate } from "./rate-limit";
import { reportTtlMs } from "./report-cache";
import { explorerPacer, serverRpcClient } from "./server-rpc";
import { ttlCache } from "./ttl-cache";

// Next bundles this module into more than one chunk (the route handlers get one copy, the proof page another), so
// every budget below is kept on globalThis (see process-global.ts): one RPC health record, one report cache, one gate
// and one explorer pacer per server process, whichever copy runs. The errors that come out of them may therefore come
// from another copy's classes; the routes tell them apart by name (see inspection-outcome.ts).

// The RPC budget against the 15 s deadline. An inspection's RPC reads run in sequential steps, with the rest of each
// step in parallel. Measured by timing the engine over a reader whose every call takes 1 s: 5 steps for a plain token
// on testnet, 7 on mainnet (with a v2 pool to check), 8 through getOwner(), 10 for an EIP-1967 or ZeppelinOS proxy
// such as EURC, 12 for a beacon proxy, and 13 at most (a clone of a beacon proxy). Each call tries the chain's URLs in
// order, one 3 s attempt each, and every call in this server process skips a URL that failed for the next 60 s (see
// rpc-transport.ts). So a hung primary costs one 3 s timeout per process per minute, and an inspection meets it at
// most once: after timing out, the primary is skipped for longer than any inspection runs. With a healthy secondary
// the deepest path takes 3 s plus one round trip per step, under 7 s for 13 steps at 0.3 s each. Every endpoint
// hanging is an outage: one call alone takes 12 s on mainnet (4 × 3 s), the deadline cuts the inspection off, and it
// answers "busy" (503) without being cached.
const client = serverRpcClient();
// A clean report is kept 5 minutes, a degraded one 30 seconds (see report-cache.ts).
const cache = processGlobal("inspect.reportCache", () => ttlCache<Report>(reportTtlMs));

/** Thrown when 8 uncached inspections are already running in this server process — backpressure, not a hard failure. */
export class InspectorBusy extends Error {
  constructor() {
    super("Too many inspections are already running in this server process.");
    this.name = "InspectorBusy";
  }
}

// Caps concurrent UNCACHED inspections per server process. A cache hit or a join on an in-flight promise for the
// same address never reaches this gate: ttlCache only calls its loader for genuinely new work.
const gate = processGlobal("inspect.gate", () => inFlightGate(8, () => new InspectorBusy()));

// Blockscout's free tier allows 5 requests a second, and one inspection makes up to 4 explorer calls
// at once, plus up to 2 follow-up calls when a contract record is incomplete. A burst of inspections
// therefore waits its turn here instead of being refused and cached as "unknown". The worst case per
// server process, 8 inspections × 6 calls at 4 a second, is about 12 s, still inside the 15 s deadline;
// each request then gets at most 8 s, and none is still sent once its inspection's deadline has
// passed (see explorer-fetch.ts).
const explorerTurn = explorerPacer();

export function cachedInspection(address: Address): Promise<Report> {
  // Arc mainnet's public explorer refuses server requests (a Cloudflare bot check), so with a key the server
  // reads the same data from Blockscout's PRO API. Without one (local dev) it uses the public explorer. The key
  // is a runtime secret, read here on each call rather than at module load.
  const explorerApi = proExplorerApi(activeChain().id, process.env.BLOCKSCOUT_API_KEY);
  // The deadline races INSIDE the gate: gate.run()'s own `finally` frees the slot the instant the
  // race settles (timeout or real result), even if the underlying inspect() call keeps running.
  // ttlCache never caches a rejected promise (see ttl-cache.ts), so a timeout is never cached.
  // Each inspection has its own controller: when its deadline passes, its explorer requests stop,
  // and no other inspection's do.
  return cache.get(address.toLowerCase(), () =>
    gate.run(() => {
      const controller = new AbortController();
      const fetchFn = explorerFetch(explorerTurn, controller.signal);
      return withDeadline(inspect(inspectInput(address, client, fetchFn, explorerApi)), controller);
    }),
  );
}
