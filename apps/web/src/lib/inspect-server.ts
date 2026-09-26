import "server-only";
import { createPublicClient } from "viem";
import { activeChain, type Address } from "@arcos/chain";
import { inspect, type Report } from "@arcos/inspector";
import { withDeadline } from "./deadline";
import { explorerFetch } from "./explorer-fetch";
import { inspectInput, proExplorerApi } from "./inspect-input";
import { inFlightGate, perSecond } from "./rate-limit";
import { reportMaxAge } from "./report-cache";
import { rpcTransport } from "./rpc-transport";
import { ttlCache } from "./ttl-cache";

export { InspectionTimeout } from "./deadline";

// Each RPC call tries the chain's URLs in order, one 8 s attempt each (see rpc-transport.ts). An inspection's reads run
// in about ten sequential steps (code, proxy slots, the logic's code and slots, admin, owner and pools, token fields,
// LP lock), with the rest in parallel inside each step. An endpoint that refuses (5xx, 429, a reset connection) costs
// about one round trip before the next URL answers, so the inspection still ends well inside the 15 s deadline: that
// is the failure the fallback is for. One that accepts connections but never answers costs 8 s per step, so two steps
// reach the deadline, and one call over URLs that all hang (32 s on mainnet) outlasts it on its own. The deadline, not
// the transport, bounds an inspection; a timed-out one answers "busy" and is never cached.
const client = createPublicClient({ chain: activeChain(), transport: rpcTransport(activeChain()) });
// A clean report is kept 5 minutes, a degraded one 30 seconds (see report-cache.ts).
const cache = ttlCache<Report>((report) => reportMaxAge(report) * 1000);

/** Thrown when 8 uncached inspections are already running on this instance — backpressure, not a hard failure. */
export class InspectorBusy extends Error {
  constructor() {
    super("Too many inspections are already running on this instance.");
    this.name = "InspectorBusy";
  }
}

// Caps concurrent UNCACHED inspections. A cache hit or a join on an in-flight promise for the
// same address never reaches this gate: ttlCache only calls its loader for genuinely new work.
const gate = inFlightGate(8, () => new InspectorBusy());

// Blockscout's free tier allows 5 requests a second, and one inspection makes up to 4 explorer calls
// at once, plus up to 2 follow-up calls when a contract record is incomplete. A burst of inspections
// therefore waits its turn here instead of being refused and cached as "unknown". The worst case per
// instance, 8 inspections × 6 calls at 4 a second, is about 12 s, still inside the 15 s deadline;
// each request then gets at most 8 s, and none is still sent once its inspection's deadline has
// passed (see explorer-fetch.ts).
const explorerTurn = perSecond(4);

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
