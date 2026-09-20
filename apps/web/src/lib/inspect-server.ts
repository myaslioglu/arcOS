import "server-only";
import { createPublicClient, http } from "viem";
import { activeChain, type Address } from "@arcos/chain";
import { inspect, type Report } from "@arcos/inspector";
import { inspectInput } from "./inspect-input";
import { ttlCache } from "./ttl-cache";

const client = createPublicClient({ chain: activeChain(), transport: http() });
const cache = ttlCache<Report>(5 * 60_000);

export function cachedInspection(address: Address): Promise<Report> {
  return cache.get(address.toLowerCase(), () => inspect(inspectInput(address, client)));
}
