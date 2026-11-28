/**
 * The live suite's clients for Ethereum, Base, Arbitrum One and OP Mainnet, read-only. Each reads, in this order of choice:
 * - `LIVE_RPC_<CHAIN>` (ETHEREUM, BASE, ARBITRUM, OPTIMISM), when set: any RPC URL;
 * - Alchemy, when `INSPECT_RPC_KEY` is set, with the key in the Authorization header (never in a URL, so no error message
 *   or log line can carry it), as the site's server sends it;
 * - else the chain's public RPC, the registry's fallback.
 * Calls are paced one at a time, `GAP_MS` apart, with a back-off on a rate limit. Only read-only methods are sent
 * (eth_call, eth_getCode, eth_getStorageAt, eth_blockNumber, eth_gasPrice); no transaction, no wallet.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import type { InspectChain, InspectChainKey } from "@arcos/chain";
import { viemReader } from "../src/reader";
import type { ChainReader } from "../src/types";

const GAP_MS = 120;
const ALCHEMY: Record<Exclude<InspectChainKey, "arc">, string> = {
  ethereum: "https://eth-mainnet.g.alchemy.com/v2",
  base: "https://base-mainnet.g.alchemy.com/v2",
  arbitrum: "https://arb-mainnet.g.alchemy.com/v2",
  optimism: "https://opt-mainnet.g.alchemy.com/v2",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Which endpoint the suite reads `chain` through, by name only (never a URL that could hold a key). */
export function via(chain: InspectChain): "LIVE_RPC" | "alchemy" | "public" {
  if (process.env[`LIVE_RPC_${chain.key.toUpperCase()}`]) return "LIVE_RPC";
  return process.env.INSPECT_RPC_KEY?.trim() ? "alchemy" : "public";
}

/** The client and the paced reader for `chain`. */
export function live(chain: InspectChain): {
  client: PublicClient;
  reader: ChainReader;
  paced: <T>(call: () => Promise<T>) => Promise<T>;
  /** How many requests the reader has sent, by kind, since the last call: what an inspection costs a provider. */
  counted: () => Record<string, number>;
} {
  if (chain.key === "arc") throw new Error("Arc's live client is live/arc.ts");
  const own = process.env[`LIVE_RPC_${chain.key.toUpperCase()}`];
  const key = process.env.INSPECT_RPC_KEY?.trim();
  const transport = own
    ? http(own, { retryCount: 0, timeout: 30_000 })
    : key
      ? http(ALCHEMY[chain.key], { retryCount: 0, timeout: 30_000, fetchOptions: { headers: { authorization: `Bearer ${key}` } } })
      : http(chain.viem.rpcUrls.default.http[0], { retryCount: 0, timeout: 30_000 });
  const client = createPublicClient({ chain: chain.viem, transport, ccipRead: false }) as PublicClient;
  let nextSlot = 0;
  const paced = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const slot = Math.max(now, nextSlot);
      nextSlot = slot + GAP_MS;
      if (slot > now) await sleep(slot - now);
      try {
        return await call();
      } catch (e) {
        const said = `${(e as Error)?.message ?? ""} ${(e as { details?: string })?.details ?? ""}`;
        if (attempt < 5 && /-32005|429|rate limit|compute units/i.test(said)) {
          await sleep(1_500 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  };
  const inner = viemReader(client, chain);
  let counts: Record<string, number> = {};
  const count = <T>(kind: string, call: () => Promise<T>) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return paced(call);
  };
  const reader: ChainReader = {
    getCode: (a) => count("eth_getCode", () => inner.getCode(a)),
    getStorageAt: (a, slot, blockNumber) => count("eth_getStorageAt", () => inner.getStorageAt(a, slot, blockNumber)),
    read: (a, abi, fn, args, options) => count("eth_call", () => inner.read(a, abi, fn, args, options)),
    blockNumber: () => count("eth_blockNumber", () => inner.blockNumber()),
    gasPrice: () => count("eth_gasPrice", () => inner.gasPrice()),
    callWithOverride: (call, overrides) => count("eth_call (state override)", () => inner.callWithOverride(call, overrides)),
    logs: (filter) => count("eth_getLogs", () => inner.logs(filter)),
  };
  const counted = () => {
    const out = counts;
    counts = {};
    return out;
  };
  return { client, reader, paced, counted };
}
