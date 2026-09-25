import "server-only";
import { createPublicClient, http } from "viem";
import { activeChain, type Address } from "@arcos/chain";
import { inspect, type Report } from "@arcos/inspector";
import { withDeadline } from "./deadline";
import { inspectInput, proExplorerApi } from "./inspect-input";
import { inFlightGate, perSecond } from "./rate-limit";
import { ttlCache } from "./ttl-cache";

export { InspectionTimeout } from "./deadline";

// 8s per RPC call, one retry — an inspection makes several sequential calls, so this is a bound
// on any single one of them, not on the inspection as a whole (see withDeadline for that).
const client = createPublicClient({ chain: activeChain(), transport: http(undefined, { timeout: 8_000, retryCount: 1 }) });
const cache = ttlCache<Report>(5 * 60_000);

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
// therefore waits its turn here instead of being refused and cached as "unknown" for 5 minutes. The
// worst case per instance, 8 inspections × 6 calls at 4 a second, is about 12 s, still inside the
// 15 s deadline.
const explorerTurn = perSecond(4);
const explorerFetch: typeof fetch = async (input, init) => {
  await explorerTurn();
  return fetch(input, init);
};

export function cachedInspection(address: Address): Promise<Report> {
  // Arc mainnet's public explorer refuses server requests (a Cloudflare bot check), so with a key the server
  // reads the same data from Blockscout's PRO API. Without one (local dev) it uses the public explorer. The key
  // is a runtime secret, read here on each call rather than at module load.
  const explorerApi = proExplorerApi(activeChain().id, process.env.BLOCKSCOUT_API_KEY);
  // The deadline races INSIDE the gate: gate.run()'s own `finally` frees the slot the instant the
  // race settles (timeout or real result), even if the underlying inspect() call keeps running.
  // ttlCache never caches a rejected promise (see ttl-cache.ts), so a timeout is never cached.
  return cache.get(address.toLowerCase(), () =>
    gate.run(() => withDeadline(inspect(inspectInput(address, client, explorerFetch, explorerApi)))),
  );
}
