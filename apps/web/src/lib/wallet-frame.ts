/**
 * Some browser wallets refuse every request from a page they take for an embedded frame. Trust Wallet's extension
 * answers "Request blocked: embedded frames are not allowed for this origin. For your security, <host> can't make this
 * request from an embedded frame."
 *
 * It does so for a page that is not in a frame at all, when Chrome loaded it ahead of time from the address bar
 * (prerendering). Such a page's main frame carries a non-zero extension frame id, which the wallet reads as an
 * iframe. The refusal lasts as long as the page does, so trying again fails the same way, and a reload, which loads
 * the page normally, lets the request through.
 *
 * The wallet sends no code of its own for this, so it's recognized by its words. They pick this app's sentence and
 * are never shown: the same rule as every other wallet error (lib/network.ts, lib/contract-error.ts).
 */
export const EMBEDDED_FRAME_MESSAGE =
  "Your wallet blocked this request because it thinks this page is embedded in another site. Reload the page and try again, or open this site in its own tab.";

const EMBEDDED_FRAME = /embedded frame/i;

/** Walks the error's `cause` chain, the shape viem's `BaseError` and the standard `Error` share, and reads each
 * node's own text: `message`, and viem's `details` and `shortMessage`. A wallet may also reject with a bare string. */
export function isEmbeddedFrameRefusal(error: unknown): boolean {
  if (typeof error === "string") return EMBEDDED_FRAME.test(error);
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    for (const key of ["message", "details", "shortMessage"]) {
      const text = (current as Record<string, unknown>)[key];
      if (typeof text === "string" && EMBEDDED_FRAME.test(text)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
