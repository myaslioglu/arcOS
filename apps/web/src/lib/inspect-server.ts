import "server-only";
import { createPublicClient, http } from "viem";
import { activeChain, type Address } from "@arcos/chain";
import { inspect, type Report } from "@arcos/inspector";
import { inspectInput } from "./inspect-input";
import { inFlightGate } from "./rate-limit";
import { ttlCache } from "./ttl-cache";

const client = createPublicClient({ chain: activeChain(), transport: http() });
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
  return cache.get(address.toLowerCase(), () => gate.run(() => inspect(inspectInput(address, client))));
}
