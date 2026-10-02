import { describe, expect, it } from "vitest";
import { SignJWT, UnsecuredJWT, decodeJwt } from "jose";
import {
  MIN_SECRET_BYTES,
  SESSION_COOKIE,
  SESSION_TTL_S,
  clearedSessionCookie,
  readSession,
  readSessionCookie,
  sessionCookie,
  sessionKey,
  signSession,
} from "../session";

// Secrets made up for this file. The real one lives in Secret Manager and is never in the repository.
const SECRET = "test-secret-".padEnd(48, "x");
const OTHER_SECRET = "another-test-secret-".padEnd(48, "y");
const KEY = sessionKey(SECRET)!;
const OTHER_KEY = sessionKey(OTHER_SECRET)!;
const AUDIENCE = "4rcos.com";
const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const opts = (now = NOW, audience = AUDIENCE) => ({ audience, now });

/** A token with claims chosen by the test, signed with KEY unless another key is given. */
function forge(claims: Record<string, unknown>, key: Uint8Array = KEY, alg = "HS256") {
  const iat = Math.floor(NOW.getTime() / 1000);
  return new SignJWT({ ver: 0, ...claims })
    .setProtectedHeader({ alg })
    .setSubject((claims.sub as string | undefined) ?? ADDRESS)
    .setAudience((claims.aud as string | undefined) ?? AUDIENCE)
    .setIssuedAt((claims.iat as number | undefined) ?? iat)
    .setExpirationTime((claims.exp as number | undefined) ?? iat + SESSION_TTL_S)
    .sign(key);
}

describe("sessionKey", () => {
  it("is null without a secret, or with one shorter than 32 bytes: sign-in is then off, never on a built-in key", () => {
    expect(MIN_SECRET_BYTES).toBe(32);
    expect(sessionKey(undefined)).toBeNull();
    expect(sessionKey("")).toBeNull();
    expect(sessionKey("x".repeat(31))).toBeNull();
    expect(sessionKey(" ".repeat(40))).toBeNull();
  });

  it("is the secret's bytes when it is long enough", () => {
    expect(sessionKey("x".repeat(32))).toEqual(new TextEncoder().encode("x".repeat(32)));
    expect(sessionKey(SECRET)?.byteLength).toBe(48);
  });
});

describe("signSession and readSession", () => {
  it("round-trips the address and the session version", async () => {
    const token = await signSession({ address: ADDRESS, version: 3 }, KEY, opts());
    await expect(readSession(token, KEY, opts())).resolves.toEqual({ address: ADDRESS, version: 3 });
  });

  it("writes an HS256 JWT of { sub: lowercase address, aud: site host, iat, exp: +7 days }", async () => {
    const token = await signSession({ address: ADDRESS.toUpperCase().replace("0X", "0x"), version: 0 }, KEY, opts());
    const claims = decodeJwt(token);
    expect(claims.sub).toBe(ADDRESS);
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.iat).toBe(NOW.getTime() / 1000);
    expect(claims.exp).toBe(NOW.getTime() / 1000 + 7 * 24 * 3600);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString())).toEqual({ alg: "HS256" });
  });

  it("makes a new token on every sign-in, even within the same second", async () => {
    const first = await signSession({ address: ADDRESS, version: 0 }, KEY, opts());
    const second = await signSession({ address: ADDRESS, version: 0 }, KEY, opts());
    expect(first).not.toBe(second);
  });

  it("rejects an expired token", async () => {
    const token = await signSession({ address: ADDRESS, version: 0 }, KEY, opts());
    await expect(readSession(token, KEY, opts(at(SESSION_TTL_S - 1)))).resolves.not.toBeNull();
    await expect(readSession(token, KEY, opts(at(SESSION_TTL_S)))).resolves.toBeNull();
    await expect(readSession(token, KEY, opts(at(SESSION_TTL_S + 3600)))).resolves.toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signSession({ address: ADDRESS, version: 0 }, OTHER_KEY, opts());
    await expect(readSession(token, KEY, opts())).resolves.toBeNull();
  });

  it("rejects a session whose sub isn't an address", async () => {
    for (const sub of ["alice", "0x1234", ADDRESS.toUpperCase().replace("0X", "0x"), `${ADDRESS} `]) {
      await expect(readSession(await forge({ sub }), KEY, opts()), sub).resolves.toBeNull();
    }
  });

  it("rejects a token for another site", async () => {
    const token = await signSession({ address: ADDRESS, version: 0 }, KEY, opts(NOW, "testnet.4rcos.com"));
    await expect(readSession(token, KEY, opts())).resolves.toBeNull();
  });

  it("rejects a token without a usable session version", async () => {
    for (const ver of [undefined, -1, 1.5, "0", null]) {
      await expect(readSession(await forge({ ver }), KEY, opts()), String(ver)).resolves.toBeNull();
    }
  });

  it("rejects a token that claims to live longer than 7 days, or was issued in the future", async () => {
    const iat = NOW.getTime() / 1000;
    await expect(readSession(await forge({ exp: iat + SESSION_TTL_S + 60 }), KEY, opts())).resolves.toBeNull();
    await expect(readSession(await forge({ iat: iat + 600, exp: iat + 1200 }), KEY, opts())).resolves.toBeNull();
  });

  it("rejects an unsigned token, another algorithm, a tampered one and junk", async () => {
    const unsigned = new UnsecuredJWT({ ver: 0 })
      .setSubject(ADDRESS)
      .setAudience(AUDIENCE)
      .setIssuedAt(NOW.getTime() / 1000)
      .setExpirationTime(NOW.getTime() / 1000 + 60)
      .encode();
    await expect(readSession(unsigned, KEY, opts())).resolves.toBeNull();
    await expect(readSession(await forge({}, KEY, "HS512"), KEY, opts())).resolves.toBeNull();

    const token = await signSession({ address: ADDRESS, version: 0 }, KEY, opts());
    const [header, , signature] = token.split(".");
    const payload = Buffer.from(JSON.stringify({ ...decodeJwt(token), ver: 9 })).toString("base64url");
    await expect(readSession(`${header}.${payload}.${signature}`, KEY, opts())).resolves.toBeNull();

    for (const junk of ["", "a.b.c", "x".repeat(5000), `${token}.x`, `${token} `]) {
      await expect(readSession(junk, KEY, opts())).resolves.toBeNull();
    }
  });
});

describe("the session cookie", () => {
  it("is __Host-arcos_session, HttpOnly, Secure, SameSite=Lax, on Path=/, for 7 days", () => {
    expect(SESSION_COOKIE).toBe("__Host-arcos_session");
    expect(sessionCookie("t.o.k")).toBe(
      "__Host-arcos_session=t.o.k; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("is cleared with the same attributes and Max-Age=0", () => {
    expect(clearedSessionCookie()).toBe("__Host-arcos_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  });

  // A browser drops a __Host- cookie unless it is Secure, on Path=/ and has no Domain, on the set and the clear alike.
  it("meets the __Host- prefix rules when set and when cleared", () => {
    for (const header of [sessionCookie("t.o.k"), clearedSessionCookie()]) {
      const [pair, ...attributes] = header.split("; ");
      expect(pair!.startsWith("__Host-")).toBe(true);
      expect(attributes).toContain("Secure");
      expect(attributes).toContain("Path=/");
      expect(attributes.filter((a) => a.toLowerCase().startsWith("domain"))).toEqual([]);
      expect(attributes.filter((a) => a.toLowerCase().startsWith("path="))).toEqual(["Path=/"]);
    }
  });

  it("is read from a Cookie header", () => {
    expect(readSessionCookie("__Host-arcos_session=a.b.c")).toBe("a.b.c");
    expect(readSessionCookie("theme=dark; __Host-arcos_session=a.b.c; other=1")).toBe("a.b.c");
    expect(readSessionCookie("theme=dark;__Host-arcos_session=a.b.c")).toBe("a.b.c");
  });

  it("reads nothing when it is missing, empty, unprefixed, or sent twice", () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie("")).toBeNull();
    expect(readSessionCookie("theme=dark")).toBeNull();
    expect(readSessionCookie("__Host-arcos_session=")).toBeNull();
    expect(readSessionCookie("x__Host-arcos_session=a.b.c")).toBeNull();
    // The unprefixed name carries no __Host- guarantee (any subdomain could set it), so it is not a session.
    expect(readSessionCookie("arcos_session=a.b.c")).toBeNull();
    // Two cookies of the same name: neither is trusted.
    expect(readSessionCookie("__Host-arcos_session=a.b.c; __Host-arcos_session=d.e.f")).toBeNull();
  });
});
