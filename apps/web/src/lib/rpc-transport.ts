import { HttpRequestError, TimeoutError, createTransport, http, type Chain, type EIP1193RequestFn, type Transport } from "viem";

/** viem's per-request timeout for one attempt at one URL. */
const ATTEMPT_MS = 3_000;
/** How long an endpoint that failed at the transport level is skipped. */
const COOLDOWN_MS = 60_000;

/** The endpoint failed (it timed out, answered an HTTP error status, or couldn't be reached), as opposed to answering
 * the call with a JSON-RPC error: a revert, invalid params or OutOfFunds is the chain's answer. */
const endpointFailed = (e: unknown): boolean => e instanceof HttpRequestError || e instanceof TimeoutError;

type Endpoint = ReturnType<Transport>;

export type RpcTransportOptions = {
  /** One endpoint's transport. Default: viem's HTTP transport, one attempt of at most 3 s, no retry of its own. */
  connect?: (url: string) => Transport;
  /** The clock the cooldowns are kept against. */
  now?: () => number;
};

/**
 * The server's RPC transport. Every call tries the chain's URLs (`rpcUrls.default.http`) in list order, the first one
 * primary, one attempt of at most 3 s each, and returns the first answer. An endpoint whose call fails at the transport
 * level is skipped by every call for the next 60 s, so a hung endpoint costs one 3 s timeout per minute instead of one
 * per call. If every endpoint is cooling down, all of them are tried in list order again, and one that answers is back
 * in use at once. A JSON-RPC error is the chain answering: it goes straight back to the caller, no other endpoint is
 * asked and nothing cools down.
 *
 * The cooldowns are one timestamp per URL, compared against `now()` when a call starts; nothing runs in the background.
 * They live as long as the transport, and inspect-server.ts builds its one when it loads, so they are per instance.
 *
 * One call's worst case, every URL hanging, is (number of URLs) × 3 s: 12 s over mainnet's four, 9 s over testnet's
 * three.
 */
export function rpcTransport(
  chain: Chain,
  { connect = (url) => http(url, { timeout: ATTEMPT_MS, retryCount: 0 }), now = () => Date.now() }: RpcTransportOptions = {},
): Transport<"cooldown", { transports: Endpoint[] }> {
  const urls = chain.rpcUrls.default.http;
  const coolingUntil = new Map<string, number>();
  return (({ chain: forChain }) => {
    const endpoints = urls.map((url) => ({ url, transport: connect(url)({ chain: forChain, retryCount: 0 }) }));
    const request = (async (args: Parameters<EIP1193RequestFn>[0]) => {
      const start = now();
      const ready = endpoints.filter(({ url }) => (coolingUntil.get(url) ?? 0) <= start);
      let failure: unknown;
      for (const { url, transport } of ready.length > 0 ? ready : endpoints) {
        try {
          const answer: unknown = await transport.request(args);
          coolingUntil.delete(url);
          return answer;
        } catch (e) {
          if (!endpointFailed(e)) throw e;
          coolingUntil.set(url, now() + COOLDOWN_MS);
          failure = e;
        }
      }
      throw failure;
    }) as EIP1193RequestFn;
    return createTransport(
      { key: "cooldown", name: "RPC endpoints with a cooldown", type: "cooldown", retryCount: 0, request },
      { transports: endpoints.map(({ transport }) => transport) },
    );
  }) as Transport<"cooldown", { transports: Endpoint[] }>;
}
