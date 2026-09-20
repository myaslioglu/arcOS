import "server-only";
import { createPublicClient, http } from "viem";
import { activeChain, type Address } from "@arcos/chain";
import { inspect, type Report } from "@arcos/inspector";
import { withDeadline } from "./deadline";
import { inspectInput } from "./inspect-input";
import { inFlightGate } from "./rate-limit";
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

export function cachedInspection(address: Address): Promise<Report> {
  // The deadline races INSIDE the gate: gate.run()'s own `finally` frees the slot the instant the
  // race settles (timeout or real result), even if the underlying inspect() call keeps running.
  // ttlCache never caches a rejected promise (see ttl-cache.ts), so a timeout is never cached.
  return cache.get(address.toLowerCase(), () => gate.run(() => withDeadline(inspect(inspectInput(address, client)))));
}
