import { SignJWT, jwtVerify } from "jose";

// The session cookie of design 1.4: `arcos_session`, an HS256 JWT { sub: lowercase address, aud: site host, iat,
// exp: +7 days }, keyed with ARCOS_SESSION_SECRET. It also carries `ver`, the user's session version when it was
// signed (users/{address}.sessionVersion), so signing out ends every cookie issued before, and a `jti`, so each
// sign-in gets a new token. Pure: the secret and the clock are passed in, and nothing here logs.

export const SESSION_COOKIE = "arcos_session";
export const SESSION_TTL_S = 7 * 24 * 60 * 60;
/** The secret is 32 random bytes or more (design 1.8). A shorter one turns sign-in off rather than weakening it. */
export const MIN_SECRET_BYTES = 32;
const ALG = "HS256";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 1024;
const CLOCK_SKEW_S = 60;
const ATTRIBUTES = "Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax";

export type SessionClaims = { address: string; version: number };

/**
 * The signing key, from the secret's bytes, or null when the secret is missing, blank or shorter than 32 bytes. There
 * is no fallback key: without the secret, sign-in is off.
 */
export function sessionKey(secret: string | undefined): Uint8Array | null {
  if (!secret || secret.trim() === "") return null;
  const key = new TextEncoder().encode(secret);
  return key.byteLength >= MIN_SECRET_BYTES ? key : null;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** A new session token for `address`, valid for 7 days from `now`, for the site `audience` (its host). */
export async function signSession(
  claims: SessionClaims,
  key: Uint8Array,
  options: { audience: string; now: Date },
): Promise<string> {
  const iat = seconds(options.now);
  return new SignJWT({ ver: claims.version })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.address.toLowerCase())
    .setAudience(options.audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_S)
    .setJti(crypto.randomUUID())
    .sign(key);
}

/**
 * The claims of a token this site signed with `key` for `audience`, or null for anything else: another key or
 * algorithm, an unsigned or altered token, another site, an expired token, one issued in the future or claiming more
 * than 7 days, a `sub` that isn't a lowercase address, or a `ver` that isn't a whole number. It never throws.
 */
export async function readSession(
  token: string,
  key: Uint8Array,
  options: { audience: string; now: Date },
): Promise<SessionClaims | null> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(token)) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALG],
      audience: options.audience,
      currentDate: options.now,
      requiredClaims: ["sub", "aud", "iat", "exp"],
    });
    const { sub, iat, exp, ver } = payload;
    if (typeof sub !== "string" || !ADDRESS.test(sub)) return null;
    if (typeof iat !== "number" || typeof exp !== "number") return null;
    if (iat > seconds(options.now) + CLOCK_SKEW_S || exp - iat > SESSION_TTL_S) return null;
    if (typeof ver !== "number" || !Number.isSafeInteger(ver) || ver < 0) return null;
    return { address: sub, version: ver };
  } catch {
    return null;
  }
}

/** The Set-Cookie value that stores a session: HttpOnly, Secure, SameSite=Lax, Path=/, for 7 days. */
export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; ${ATTRIBUTES.replace("%d", String(SESSION_TTL_S))}`;

/** The Set-Cookie value that removes it. */
export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; ${ATTRIBUTES.replace("%d", "0")}`;

/**
 * The session cookie's value from a Cookie header, or null when it is missing or empty. Two cookies of that name (a
 * sibling subdomain can set one for the parent domain) are ambiguous, and neither is read.
 */
export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  if (values.length !== 1 || values[0] === "") return null;
  return values[0]!;
}
