import { isUserCancellationError } from "@circle-fin/app-kit";

/**
 * Circle's `isUserCancellationError` reads any error whose own code is 4001 as the visitor cancelling (EIP-1193's
 * "user rejected"). The kit numbers its own errors too, and its RPC endpoint error (`RPC_ENDPOINT_ERROR`, what its
 * adapter reports when a send fails with no code) is also 4001, so a node or network failure read as "Cancelled.".
 *
 * For that error the question goes to the error it wraps, `cause.trace.rawError`: what the wallet or the node actually
 * answered. A wallet that rejected without a code still reads as cancelled, and a failure doesn't. Every other error
 * keeps the kit's own answer.
 */
export function isKitCancellation(err: unknown): boolean {
  if (!isKitRpcEndpointError(err)) return isUserCancellationError(err);
  const rawError = (err as { cause?: { trace?: { rawError?: unknown } } }).cause?.trace?.rawError;
  return isUserCancellationError(rawError);
}

function isKitRpcEndpointError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "RPC_ENDPOINT_ERROR";
}
