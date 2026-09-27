import { createTransport, http, type Chain, type EIP1193RequestFn, type Transport } from "viem";
import { isNodeAnswer } from "@arcos/inspector";

/** viem's per-request timeout for one attempt at one URL. */
const ATTEMPT_MS = 3_000;
/** How long an endpoint that failed is skipped. */
const COOLDOWN_MS = 60_000;

type Endpoint = ReturnType<Transport>;

export type RpcTransportOptions = {
  /** One endpoint's transport. Default: viem's HTTP transport, one attempt of at most 3 s, no retry of its own. */
  connect?: (url: string) => Transport;
  /** The clock the cooldowns are kept against. */
  now?: () => number;
};

/**
 * The server's RPC transport. Every call tries the chain's URLs (`rpcUrls.default.http`) in list order, the first one
 * primary, one attempt of at most 3 s each, and returns the first answer. The node's answer includes a revert and
 * -32602 invalid params: those go straight back to the caller, no other endpoint is asked and nothing cools down.
 * Anything else is the endpoint failing (a timeout, an HTTP error, or any other JSON-RPC error, such as a gateway's
 * -32603 or a rate limit's -32005 or -32007, whatever HTTP status carried it; see rpc-errors.ts in @arcos/inspector):
 * the next URL is asked, and this one is skipped by every call for the next 60 s. So a hung endpoint costs one 3 s
 * timeout per minute instead of one per call. If every endpoint is cooling down, all of them are tried in list order
 * again, and one that answers is back in use at once. Only an attempt sent after an endpoint's last failure can end its
 * cooldown that way: an answer that was already on its way when the endpoint failed says nothing about it since.
 *
 * viem's per-request options (a caller's `signal`) go on to the endpoint, and a call the caller aborted cools nothing.
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
  /** When each endpoint last failed, as a position in `seq`, the one counter that orders attempts and failures. */
  const failedAt = new Map<string, number>();
  let seq = 0;
  return (({ chain: forChain }) => {
    const endpoints = urls.map((url) => ({ url, transport: connect(url)({ chain: forChain, retryCount: 0 }) }));
    const request = (async (args: Parameters<EIP1193RequestFn>[0], options?: Parameters<EIP1193RequestFn>[1]) => {
      const start = now();
      const ready = endpoints.filter(({ url }) => (coolingUntil.get(url) ?? 0) <= start);
      let failure: unknown;
      for (const { url, transport } of ready.length > 0 ? ready : endpoints) {
        const attempt = ++seq;
        try {
          const answer: unknown = await transport.request(args, options);
          if ((failedAt.get(url) ?? 0) < attempt) {
            coolingUntil.delete(url);
            failedAt.delete(url);
          }
          return answer;
        } catch (e) {
          // The caller gave up, or the node answered: neither says the endpoint failed.
          if (options?.signal?.aborted || isNodeAnswer(e)) throw e;
          coolingUntil.set(url, now() + COOLDOWN_MS);
          failedAt.set(url, ++seq);
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
