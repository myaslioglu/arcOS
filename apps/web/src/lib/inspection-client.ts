import { createPublicClient, type Chain, type PublicClient } from "viem";
import { rpcTransport, type EndpointHealth } from "./rpc-transport";

/**
 * The server's RPC client for inspections, over `rpcTransport`. CCIP-Read is off: the engine reads contracts anyone can
 * deploy, and with it on, a read that reverts with EIP-3668's OffchainLookup makes viem fetch the URLs the contract
 * names, from the server and with no timeout. Such a revert is read like any other revert.
 *
 * `isNodeAnswer` is an extra classifier passed straight through to `rpcTransport` (see there): server-rpc.ts supplies
 * `outOfGasIsNodeAnswer` for both of its clients.
 */
export function inspectionClient(chain: Chain, health?: EndpointHealth, isNodeAnswer?: (e: unknown) => boolean): PublicClient {
  return createPublicClient({ chain, transport: rpcTransport(chain, { health, isNodeAnswer }), ccipRead: false });
}
