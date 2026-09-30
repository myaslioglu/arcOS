import type { Address } from "viem";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";

// Sign-in with Ethereum (EIP-4361), the parts both sides share: the browser builds the message the wallet signs, and
// the server checks it before it looks at the signature (lib/auth-server.ts). Pure: no request, no clock of its own.

/** What the wallet shows above the message. Signing is free, and the copy says so. */
export const SIGN_IN_STATEMENT = "Sign in to 4rc.OS. Signing is free and sends no transaction.";
/** How long a signed message stays usable: the same 10 minutes as the nonce in it. */
export const SIGN_IN_TTL_MS = 10 * 60_000;
/** A wallet's clock may run a little ahead of the server's. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** Our messages are about 450 characters; anything much longer is not one of them. */
export const MAX_MESSAGE_LENGTH = 2048;
const NONCE = /^[A-Za-z0-9]{16,128}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The site a message must name: its domain (host and port) and its URI (the origin), from NEXT_PUBLIC_SITE_URL. */
export type SiteIdentity = { domain: string; uri: string; scheme: "https" | "http" };

/**
 * The site's identity from its configured address, never from a request's Host header. Null when the setting is
 * missing or isn't a bare site address (a path, query, fragment or credentials), and for plain http anywhere but this
 * machine: sign-in is then off.
 */
export function siteIdentity(siteUrl: string | undefined): SiteIdentity | null {
  const text = siteUrl?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol === "https:") return { domain: url.host, uri: url.origin, scheme: "https" };
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return { domain: url.host, uri: url.origin, scheme: "http" };
  return null;
}

/** The message the wallet signs: the site's domain and URI, the active chain, the server's nonce, 10 minutes to live. */
export function buildSignInMessage(input: {
  address: Address;
  chainId: number;
  nonce: string;
  site: SiteIdentity;
  now: Date;
}): string {
  return createSiweMessage({
    domain: input.site.domain,
    address: input.address,
    statement: SIGN_IN_STATEMENT,
    uri: input.site.uri,
    version: "1",
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt: input.now,
    expirationTime: new Date(input.now.getTime() + SIGN_IN_TTL_MS),
  });
}

export type SignInRefusal = "malformed" | "fields" | "domain" | "uri" | "chain" | "time";
export type SignInCheck = { ok: true; address: Address; nonce: string } | { ok: false; reason: SignInRefusal };

const refuse = (reason: SignInRefusal): SignInCheck => ({ ok: false, reason });

/**
 * Checks a message a client says it signed, before its signature is looked at. It must be exactly the EIP-4361 text
 * viem would write for its own fields (so nothing can hide in it), carry our statement and none of the optional fields
 * our messages never have (resources, a request id, a Not Before), name this site's domain and URI and the active
 * chain, carry a nonce, and be inside its lifetime: issued no later than a few minutes from now, not expired, and
 * living no longer than 10 minutes. The answer carries the lowercase address and the nonce,
 * which the caller still has to accept exactly once.
 */
export function checkSignInMessage(
  message: unknown,
  expected: { site: SiteIdentity; chainId: number; now: Date },
): SignInCheck {
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_LENGTH) return refuse("malformed");
  if (message.includes("\r")) return refuse("malformed");

  const fields = parseSiweMessage(message);
  const { address, domain, uri, version, chainId, nonce, issuedAt, expirationTime } = fields;
  if (!address || !domain || !uri || version !== "1" || chainId === undefined || !nonce || !issuedAt || !expirationTime) {
    return refuse("malformed");
  }
  if (!NONCE.test(nonce)) return refuse("malformed");
  if ([issuedAt, expirationTime, fields.notBefore].some((date) => date !== undefined && Number.isNaN(date.getTime()))) {
    return refuse("malformed");
  }
  try {
    // The canonical text of the parsed fields must be the message itself: the parser is lenient, this is not.
    if (createSiweMessage({ ...fields, address, domain, uri, version, chainId, nonce }) !== message) return refuse("malformed");
  } catch {
    return refuse("malformed");
  }

  // Only what buildSignInMessage writes: a wallet shows the statement and resources to the user, and a message that
  // says something else, or grants something more, was not made by this site.
  if (fields.statement !== SIGN_IN_STATEMENT) return refuse("fields");
  if (fields.resources !== undefined || fields.requestId !== undefined || fields.notBefore !== undefined) return refuse("fields");

  if (domain !== expected.site.domain) return refuse("domain");
  if (fields.scheme !== undefined && fields.scheme !== expected.site.scheme) return refuse("domain");
  if (uri !== expected.site.uri) return refuse("uri");
  if (chainId !== expected.chainId) return refuse("chain");

  const now = expected.now;
  if (!validateSiweMessage({ message: fields, time: now })) return refuse("time");
  if (issuedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) return refuse("time");
  if (expirationTime.getTime() - issuedAt.getTime() > SIGN_IN_TTL_MS) return refuse("time");

  return { ok: true, address: address.toLowerCase() as Address, nonce };
}
