import "server-only";
import type { PublicClient } from "viem";
import { activeChain } from "@arcos/chain";
import { inspectionClient } from "./inspection-client";
import { processGlobal } from "./process-global";
import { perSecond } from "./rate-limit";
import { endpointHealth } from "./rpc-transport";

/**
 * The server's RPC client, one per process: the inspection engine, /api/pulse and /api/approvals all read Arc through
 * it, over the chain's URLs in order with one shared cooldown record (see rpc-transport.ts). CCIP-Read is off on it
 * (see inspection-client.ts), which matters for every route that reads contracts anyone can deploy.
 */
export function serverRpcClient(): PublicClient {
  return processGlobal("server.rpcClient", () =>
    inspectionClient(activeChain(), processGlobal("inspect.rpcHealth", endpointHealth)),
  );
}

/**
 * The explorer pacer every server route shares, one per process: at most 4 explorer requests start in any second
 * (Blockscout's free tier allows 5). Inspections and Revoke's lookups wait their turn in the same queue, and Revoke
 * runs only a couple of lookups at once (see approvals-server.ts), so it can't crowd inspections out.
 */
export function explorerPacer(): () => Promise<void> {
  return processGlobal("inspect.explorerPacer", () => perSecond(4));
}
