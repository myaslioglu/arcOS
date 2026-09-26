import { fallback, http, type Chain } from "viem";

/** viem's per-request timeout for one attempt at one URL. */
const ATTEMPT_MS = 8_000;

/**
 * The server's RPC transport: viem's `fallback` over every URL the chain lists (`rpcUrls.default.http`), tried in list
 * order on every call, so the first one stays primary. No ranking: a ranker reorders the list from latency samples it
 * takes by pinging every endpoint, from every instance, in the background.
 *
 * Each URL gets one attempt of at most 8 s, and the fallback itself doesn't retry: a retry would walk the whole list
 * again, after a backoff that honours a `Retry-After` header of any length. So one call's worst case, every URL hanging
 * until it times out, is (number of URLs) × 8 s: 32 s over mainnet's four URLs, 24 s over testnet's three. A revert
 * isn't a failure to fall back from: viem hands it straight back from the URL that answered.
 */
export function rpcTransport(chain: Chain) {
  return fallback(
    chain.rpcUrls.default.http.map((url) => http(url, { timeout: ATTEMPT_MS, retryCount: 0 })),
    { rank: false, retryCount: 0 },
  );
}
