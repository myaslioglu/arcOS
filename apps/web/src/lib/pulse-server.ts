import "server-only";
import { PULSE_BLOCKS, pulseCache, toPulse, type Pulse } from "./pulse";
import { processGlobal } from "./process-global";
import { serverRpcClient } from "./server-rpc";

// One cache per server process, shared by every bundled copy of this module (see process-global.ts).
const cache = processGlobal("pulse.cache", () =>
  pulseCache(async () =>
    toPulse(await serverRpcClient().getFeeHistory({ blockCount: PULSE_BLOCKS, blockTag: "latest", rewardPercentiles: [] })),
  ),
);

/** The last 1,024 blocks' gas-used ratios: eth_feeHistory through the server's RPC client and its fallback over Arc's URLs. */
export function cachedPulse(): Promise<Pulse> {
  return cache.get();
}
