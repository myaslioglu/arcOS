import { isUserCancellationError } from "@circle-fin/app-kit";

/**
 * Circle's `isUserCancellationError` reads an error as the visitor cancelling when its text holds a phrase such as
 * "user rejected" or "cancelled", or when its own code is 4001 (EIP-1193's "user rejected"). The kit numbers its own
 * errors too, and its RPC endpoint error (`RPC_ENDPOINT_ERROR`) is also 4001. Its adapter files a failed send there by
 * the failure's text, a send the wallet refused with no code included, so a node or network failure read as
 * "Cancelled.".
 *
 * For that error the question goes to what it wraps, `cause.trace.rawError`, and on down that error's own `cause`
 * chain, where a wallet's bare-string rejection or its nested words end up. A wallet that rejected in words the kit
 * knows still reads as cancelled; a failure doesn't, and neither does a rejection in words outside the kit's list,
 * which gets the "may still have gone through" reading instead: the safe side. Every other error keeps the kit's own
 * answer.
 */
export function isKitCancellation(err: unknown): boolean {
  if (!isKitRpcEndpointError(err)) return askKit(err);
  const seen = new Set<unknown>();
  let current: unknown = (err as { cause?: { trace?: { rawError?: unknown } } }).cause?.trace?.rawError;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (askKit(current)) return true;
    if (typeof current !== "object") return false;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isKitRpcEndpointError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "RPC_ENDPOINT_ERROR";
}

/** The kit's own check. It `JSON.stringify`s an object that isn't an `Error`, which throws on a loop: that reads as no,
 * since Swap and Bridge call this from their catch blocks and must still report the failure. */
function askKit(err: unknown): boolean {
  try {
    return isUserCancellationError(err);
  } catch {
    return false;
  }
}
