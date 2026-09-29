/**
 * Some browser wallets refuse every request from a page they take for an embedded frame. Trust Wallet's extension
 * answers "Request blocked: embedded frames are not allowed for this origin. For your security, <host> can't make this
 * request from an embedded frame."
 *
 * It does so for a page that is not in a frame at all, when Chrome loaded it ahead of time from the address bar
 * (prerendering). Such a page's main frame carries a non-zero extension frame id, which the wallet reads as an
 * iframe. The refusal lasts as long as the page does, so trying again fails the same way, and a reload, which loads
 * the page normally, lets the request through. Since the wallet refuses the first request, nothing was sent.
 *
 * The wallet sends no code of its own for this, so it's recognized by its words. They pick this app's sentence and
 * are never shown: the same rule as every other wallet error (lib/network.ts, lib/contract-error.ts).
 */
export const EMBEDDED_FRAME_MESSAGE =
  "Your wallet blocked this request because it thinks this page is embedded in another site. Reload the page and try again, or open this site in its own tab.";

const EMBEDDED_FRAME = /embedded frame/i;

/** Where Circle's App Kit keeps an error it wraps (see `isEmbeddedFrameRefusal`). */
type KitTrace = { rawError?: unknown; originalError?: unknown };

/**
 * Walks the error's `cause` chain, the shape viem's `BaseError` and the standard `Error` share, reading each node's own
 * text. A wallet may also reject with a bare string, at the top or as a cause.
 *
 * - **A viem error** (one with a `shortMessage`) is read by its `details` alone, which carry the wallet's own words up
 *   the chain. Its `message` also holds the call's arguments, which can be text the visitor typed (a token's name), and
 *   its `shortMessage` can hold a contract's own revert reason.
 * - **Circle's App Kit** keeps the error it wraps under `cause.trace.rawError` (a send the wallet refused; with no
 *   code, the kit calls it an RPC endpoint error), under `rawError`, or under `cause.trace.originalError`, so the
 *   walk follows those too.
 */
export function isEmbeddedFrameRefusal(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (typeof current === "string") return EMBEDDED_FRAME.test(current);
    if (typeof current !== "object") return false;
    seen.add(current);
    const node = current as Record<string, unknown>;
    const fields = typeof node.shortMessage === "string" ? ["details"] : ["message", "details"];
    if (fields.some((key) => typeof node[key] === "string" && EMBEDDED_FRAME.test(node[key] as string))) return true;
    const trace = node.trace !== null && typeof node.trace === "object" ? (node.trace as KitTrace) : undefined;
    current = node.cause ?? node.rawError ?? trace?.rawError ?? trace?.originalError;
  }
  return false;
}
