/**
 * The live suites' one client for Arc mainnet's public RPC, and the pacing every call goes through: one call at a time,
 * `GAP_MS` apart, with a back-off when the node says -32005. Only read-only methods are ever sent (eth_call, eth_getCode,
 * eth_getStorageAt, eth_blockNumber); no transaction, no key.
 */
import { createPublicClient, http } from "viem";
import { CHAINS } from "@arcos/chain";
import { viemReader } from "../src/reader";
import type { ChainReader } from "../src/types";

const RPC = "https://rpc.mainnet.arc.io";
const GAP_MS = 400;

export const client = createPublicClient({ chain: CHAINS.mainnet, transport: http(RPC, { retryCount: 0, timeout: 30_000 }) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let nextSlot = 0;

/** One call at a time, `GAP_MS` apart; a rate-limit answer (-32005) waits and tries again. */
export async function paced<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + GAP_MS;
    if (slot > now) await sleep(slot - now);
    try {
      return await call();
    } catch (e) {
      const said = `${(e as Error)?.message ?? ""} ${(e as { details?: string })?.details ?? ""}`;
      if (attempt < 5 && /-32005|rate limit/i.test(said)) {
        await sleep(1_500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

const inner = viemReader(client);
export const reader: ChainReader = {
  getCode: (a) => paced(() => inner.getCode(a)),
  getStorageAt: (a, slot) => paced(() => inner.getStorageAt(a, slot)),
  read: (a, abi, fn, args, options) => paced(() => inner.read(a, abi, fn, args, options)),
  blockNumber: () => paced(() => inner.blockNumber()),
  callWithOverride: (call, overrides) => paced(() => inner.callWithOverride(call, overrides)),
};
