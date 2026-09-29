import { createTransport, http, type Chain, type EIP1193RequestFn, type Transport } from "viem";
import { isNodeAnswer } from "@arcos/inspector";

/** viem's per-request timeout for one attempt at one URL. */
const ATTEMPT_MS = 3_000;
/** How long an endpoint that failed is skipped. */
const COOLDOWN_MS = 60_000;

type Endpoint = ReturnType<Transport>;

/**
 * What the transports sharing it know about the endpoints: until when each one is skipped, and when it last failed,
 * as a position in `seq`, the one counter that orders every attempt and failure.
 */
export type EndpointHealth = { coolingUntil: Map<string, number>; failedAt: Map<string, number>; seq: number };
export const endpointHealth = (): EndpointHealth => ({ coolingUntil: new Map(), failedAt: new Map(), seq: 0 });

export type RpcTransportOptions = {
  /** One endpoint's transport. Default: viem's HTTP transport, one attempt of at most 3 s, no retry of its own. */
  connect?: (url: string) => Transport;
  /** The clock the cooldowns are kept against. */
  now?: () => number;
  /** The cooldowns, shared by every transport given the same one. Default: this transport's own. */
  health?: EndpointHealth;
  /**
   * An additional "the node answered, not the endpoint failing" rule, checked alongside the shared one
   * (rpc-errors.ts) but never in place of it. Opt-in and undefined by default: only Revoke's client supplies one
   * (`outOfGasIsNodeAnswer`, below), since an out-of-gas answer isn't the right call for every reader of the chain.
   */
  isNodeAnswer?: (e: unknown) => boolean;
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
 * viem's per-request options (a caller's `signal`) go on to the endpoint. A caller's signal would replace viem's own
 * timeout signal on the request, so each attempt gets both: the caller's, and the 3 s the attempt may take. A call the
 * caller aborted cools nothing; an attempt that runs out of its 3 s is the endpoint failing, as always.
 *
 * The cooldowns are one timestamp per URL, compared against `now()` when a call starts; nothing runs in the background.
 * They live in `health`, which inspect-server.ts keeps once per server process (see process-global.ts), so every
 * bundled copy of it skips the same endpoints.
 *
 * One call's worst case, every URL hanging, is (number of URLs) × 3 s: 12 s over mainnet's four, 9 s over testnet's
 * three.
 */
export function rpcTransport(
  chain: Chain,
  {
    connect = (url) => http(url, { timeout: ATTEMPT_MS, retryCount: 0 }),
    now = () => Date.now(),
    health = endpointHealth(),
    isNodeAnswer: extraIsNodeAnswer,
  }: RpcTransportOptions = {},
): Transport<"cooldown", { transports: Endpoint[] }> {
  const urls = chain.rpcUrls.default.http;
  const { coolingUntil, failedAt } = health;
  return (({ chain: forChain }) => {
    const endpoints = urls.map((url) => ({ url, transport: connect(url)({ chain: forChain, retryCount: 0 }) }));
    const request = (async (args: Parameters<EIP1193RequestFn>[0], options?: Parameters<EIP1193RequestFn>[1]) => {
      const start = now();
      const ready = endpoints.filter(({ url }) => (coolingUntil.get(url) ?? 0) <= start);
      let failure: unknown;
      for (const { url, transport } of ready.length > 0 ? ready : endpoints) {
        const attempt = ++health.seq;
        const attemptOptions = options?.signal
          ? { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(ATTEMPT_MS)]) }
          : options;
        try {
          const answer: unknown = await transport.request(args, attemptOptions);
          if ((failedAt.get(url) ?? 0) < attempt) {
            coolingUntil.delete(url);
            failedAt.delete(url);
          }
          return answer;
        } catch (e) {
          // The caller gave up (its own signal, not this attempt's timeout), or the node answered (the shared rule,
          // or this transport's own extra one): neither says the endpoint failed.
          if (options?.signal?.aborted || isNodeAnswer(e) || extraIsNodeAnswer?.(e)) throw e;
          coolingUntil.set(url, now() + COOLDOWN_MS);
          failedAt.set(url, ++health.seq);
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

/** Arc's code for an eth_call that ran out of gas mid-execution, distinct from -32000 "intrinsic gas too low". */
const OUT_OF_GAS_CODE = -32003;
const OUT_OF_GAS_TEXT = /^out of gas/i;

/**
 * An `isNodeAnswer` override for Revoke's client alone (see server-rpc.ts). Arc answers an eth_call that runs out of
 * gas during execution with -32003 "out of gas: gas required exceeds: N" — unlike a revert, that message never
 * contains "revert", so the shared classifier (rpc-errors.ts, imported above) reads it as the endpoint failing. A
 * multicall target whose fallback burns unbounded gas would then fail over to, and cool, every endpoint on one
 * attempt. This is Arc's own out-of-gas shape specifically: a different -32003 (a custom revert reason, say) still
 * reaches the shared classifier's text check unaffected, and -32000 "intrinsic gas too low" still fails over as any
 * other JSON-RPC error does.
 */
export function outOfGasIsNodeAnswer(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const link = e as { code?: unknown; shortMessage?: unknown; details?: unknown; message?: unknown };
  if (link.code !== OUT_OF_GAS_CODE) return false;
  const text = typeof link.shortMessage === "string" ? link.details : link.message;
  return typeof text === "string" && OUT_OF_GAS_TEXT.test(text);
}
