import type { Address, Hex } from "viem";
import { buildSignInMessage, siteIdentity } from "./siwe";

// The browser's half of sign-in: nonce, then the wallet signs the site's message (free, no transaction), then verify.
// SignInGate runs it with wagmi's signMessage; it takes fetch and the clock as arguments so a test can drive it.

export const SIGN_IN_UNAVAILABLE = "Sign-in isn't available right now.";
const FAILED = "Sign-in failed. Try again.";
const CANCELLED = "You cancelled the request in your wallet.";
const WALLET_FAILED = "Your wallet couldn't sign the message. Try again.";
const NONCE = /^[A-Za-z0-9]{16,128}$/;

export type SignInOutcome = { ok: true; address: string } | { ok: false; error: string };
export type SessionInfo = { address: string; telegram: "linked" | "unlinked" };

/** The server's own error sentence from a JSON answer, or null. Only short plain strings are shown. */
async function serverError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 && body.error.length <= 200 ? body.error : null;
  } catch {
    return null;
  }
}

/** A refusal in the wallet: viem's UserRejectedRequestError anywhere in the cause chain, or EIP-1193 code 4001. */
function isUserRejection(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const { code, name } = current as { code?: unknown; name?: unknown };
    if (code === 4001 || name === "UserRejectedRequestError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function signInWithWallet(input: {
  address: Address;
  chainId: number;
  signMessage: (args: { message: string }) => Promise<Hex>;
  siteUrl: string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<SignInOutcome> {
  const site = siteIdentity(input.siteUrl);
  if (!site) return { ok: false, error: SIGN_IN_UNAVAILABLE };
  const request = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date());

  let nonce: string;
  try {
    const res = await request("/api/auth/nonce", { credentials: "same-origin" });
    if (!res.ok) return { ok: false, error: (await serverError(res)) ?? FAILED };
    const body = (await res.json()) as { nonce?: unknown };
    if (typeof body.nonce !== "string" || !NONCE.test(body.nonce)) return { ok: false, error: FAILED };
    nonce = body.nonce;
  } catch {
    return { ok: false, error: FAILED };
  }

  const message = buildSignInMessage({ address: input.address, chainId: input.chainId, nonce, site, now: now() });
  let signature: Hex;
  try {
    signature = await input.signMessage({ message });
  } catch (error) {
    return { ok: false, error: isUserRejection(error) ? CANCELLED : WALLET_FAILED };
  }

  try {
    const res = await request("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ message, signature }),
    });
    if (!res.ok) return { ok: false, error: (await serverError(res)) ?? FAILED };
    const body = (await res.json()) as { address?: unknown };
    return typeof body.address === "string" ? { ok: true, address: body.address } : { ok: false, error: FAILED };
  } catch {
    return { ok: false, error: FAILED };
  }
}

/** The current session, null when signed out, or "unavailable" when sign-in is off or the server can't be reached. */
export async function fetchSession(request: typeof fetch = fetch): Promise<SessionInfo | null | "unavailable"> {
  try {
    const res = await request("/api/auth/me", { credentials: "same-origin" });
    if (res.status === 401) return null;
    if (!res.ok) return "unavailable";
    const body = (await res.json()) as Partial<SessionInfo>;
    if (typeof body.address !== "string" || (body.telegram !== "linked" && body.telegram !== "unlinked")) return "unavailable";
    return { address: body.address, telegram: body.telegram };
  } catch {
    return "unavailable";
  }
}

export async function signOut(request: typeof fetch = fetch): Promise<void> {
  await request("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}
