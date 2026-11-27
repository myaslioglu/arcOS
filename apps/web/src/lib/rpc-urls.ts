import "server-only";
import type { InspectChain, InspectChainKey } from "@arcos/chain";

/**
 * Where the server reads a chain other than Arc (Inspector on Ethereum, Base, Arbitrum One and OP Mainnet): a keyed RPC
 * provider first, then the chain's public RPC from the registry, in that order (rpc-transport.ts in @arcos/inspector
 * tries them in turn and cools one that fails). Server-only, read at runtime: the key never reaches a bundle, and the
 * browser never reads these chains (the Inspector window asks /api/inspect).
 *
 * The provider is Alchemy, one key for the four chains, from the runtime secret `INSPECT_RPC_KEY`. It goes in the
 * Authorization header, never in the URL: viem writes a request's URL into the message of every error it makes, so a key
 * in the path could reach a log line or a report. Without the secret (local dev, CI, the testnet site, or before the
 * owner has created it) the public RPC is all there is. Arc is not read through here: its server clients are
 * server-rpc.ts's.
 */

/** One endpoint: its URL, and the headers each request to it carries. */
export type RpcEndpoint = { url: string; headers?: Record<string, string> };

/** Alchemy's endpoint for each chain: the key is sent as `Authorization: Bearer <key>` (measured to work, 2026-11-27). */
export const ALCHEMY_URLS: Record<Exclude<InspectChainKey, "arc">, string> = {
  ethereum: "https://eth-mainnet.g.alchemy.com/v2",
  base: "https://base-mainnet.g.alchemy.com/v2",
  arbitrum: "https://arb-mainnet.g.alchemy.com/v2",
  optimism: "https://opt-mainnet.g.alchemy.com/v2",
};

/**
 * The provider key, trimmed, or undefined when there is none. The word `none` is no key too: App Hosting refuses an empty
 * value, so the testnet site's settings can name the variable with `none` (as they do for BLOCKSCOUT_API_KEY).
 */
export function inspectRpcKey(raw: string | undefined = process.env.INSPECT_RPC_KEY): string | undefined {
  const key = raw?.trim();
  return key && key !== "none" ? key : undefined;
}

/** `chain`'s endpoints, in the order they are tried: the keyed provider when there is a key, then the public RPC. */
export function inspectRpcEndpoints(chain: InspectChain, key: string | undefined = inspectRpcKey()): RpcEndpoint[] {
  const publicUrls = chain.viem.rpcUrls.default.http.map((url): RpcEndpoint => ({ url }));
  if (chain.key === "arc" || !key) return publicUrls;
  return [{ url: ALCHEMY_URLS[chain.key], headers: { authorization: `Bearer ${key}` } }, ...publicUrls];
}
