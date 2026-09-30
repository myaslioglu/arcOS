import { describe, expect, it } from "vitest";
import { parseSiweMessage } from "viem/siwe";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  MAX_MESSAGE_LENGTH,
  SIGN_IN_STATEMENT,
  SIGN_IN_TTL_MS,
  buildSignInMessage,
  checkSignInMessage,
  siteIdentity,
  type SiteIdentity,
} from "../siwe";

const SITE: SiteIdentity = { domain: "4rcos.com", uri: "https://4rcos.com", scheme: "https" };
const CHAIN_ID = 5042;
const NONCE = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-09-30T12:00:00.000Z");
// A key made for this test run only; it never holds anything.
const ACCOUNT = privateKeyToAccount(generatePrivateKey());

const build = (overrides: Partial<Parameters<typeof buildSignInMessage>[0]> = {}) =>
  buildSignInMessage({ address: ACCOUNT.address, chainId: CHAIN_ID, nonce: NONCE, site: SITE, now: NOW, ...overrides });
const check = (message: unknown, now = NOW, site = SITE, chainId = CHAIN_ID) =>
  checkSignInMessage(message, { site, chainId, now });
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("siteIdentity", () => {
  it("takes the domain and the URI from NEXT_PUBLIC_SITE_URL", () => {
    expect(siteIdentity("https://4rcos.com")).toEqual(SITE);
    expect(siteIdentity("https://4rcos.com/")).toEqual(SITE);
    expect(siteIdentity("https://testnet.4rcos.com")).toEqual({
      domain: "testnet.4rcos.com",
      uri: "https://testnet.4rcos.com",
      scheme: "https",
    });
  });

  it("keeps a port, and allows plain http only on this machine", () => {
    expect(siteIdentity("http://localhost:3000")).toEqual({
      domain: "localhost:3000",
      uri: "http://localhost:3000",
      scheme: "http",
    });
    expect(siteIdentity("http://127.0.0.1:3000")?.domain).toBe("127.0.0.1:3000");
    expect(siteIdentity("http://4rcos.com")).toBeNull();
  });

  it("is null when the setting is missing or is not a plain site address", () => {
    for (const value of [undefined, "", "   ", "4rcos.com", "ftp://4rcos.com", "https://user:pw@4rcos.com", "https://4rcos.com/app", "https://4rcos.com/?q=1", "https://4rcos.com/#x", "not a url"]) {
      expect(siteIdentity(value), String(value)).toBeNull();
    }
  });
});

describe("buildSignInMessage", () => {
  it("sets the domain, URI, chain id, nonce, statement and a 10-minute expiration", () => {
    const message = build();
    const parsed = parseSiweMessage(message);
    expect(parsed.domain).toBe("4rcos.com");
    expect(parsed.uri).toBe("https://4rcos.com");
    expect(parsed.chainId).toBe(CHAIN_ID);
    expect(parsed.nonce).toBe(NONCE);
    expect(parsed.version).toBe("1");
    expect(parsed.address).toBe(ACCOUNT.address);
    expect(parsed.statement).toBe(SIGN_IN_STATEMENT);
    expect(parsed.issuedAt?.toISOString()).toBe(NOW.toISOString());
    expect(parsed.expirationTime?.getTime()).toBe(NOW.getTime() + SIGN_IN_TTL_MS);
    expect(SIGN_IN_TTL_MS).toBe(10 * 60_000);
  });

  it("says that signing is free and sends no transaction", () => {
    expect(SIGN_IN_STATEMENT).toMatch(/free/);
    expect(SIGN_IN_STATEMENT).toMatch(/no transaction/);
  });

  it("checksums a lowercase address", () => {
    const parsed = parseSiweMessage(build({ address: ACCOUNT.address.toLowerCase() as `0x${string}` }));
    expect(parsed.address).toBe(ACCOUNT.address);
  });
});

describe("checkSignInMessage", () => {
  it("accepts the message the builder makes, and answers its address (lowercase) and nonce", () => {
    expect(check(build())).toEqual({ ok: true, address: ACCOUNT.address.toLowerCase(), nonce: NONCE });
    expect(check(build(), at(SIGN_IN_TTL_MS - 1))).toMatchObject({ ok: true });
  });

  it("refuses another domain, even when the request came to that host", () => {
    const message = build({ site: { domain: "evil.example", uri: "https://evil.example", scheme: "https" } });
    expect(check(message)).toEqual({ ok: false, reason: "domain" });
    const lookalike = build({ site: { domain: "4rcos.com.evil.example", uri: "https://4rcos.com", scheme: "https" } });
    expect(check(lookalike)).toEqual({ ok: false, reason: "domain" });
  });

  it("refuses another URI", () => {
    expect(check(build({ site: { ...SITE, uri: "https://evil.example" } }))).toEqual({ ok: false, reason: "uri" });
    expect(check(build({ site: { ...SITE, uri: "https://4rcos.com/other" } }))).toEqual({ ok: false, reason: "uri" });
  });

  it("refuses another chain", () => {
    expect(check(build({ chainId: 1 }))).toEqual({ ok: false, reason: "chain" });
  });

  it("refuses a scheme that is not the site's", () => {
    const message = build().replace(/^4rcos\.com /, "http://4rcos.com ");
    expect(check(message)).toEqual({ ok: false, reason: "domain" });
    const same = build().replace(/^4rcos\.com /, "https://4rcos.com ");
    expect(check(same)).toMatchObject({ ok: true });
  });

  it("refuses an expired message, one not yet issued, and one that lives longer than 10 minutes", () => {
    expect(check(build(), at(SIGN_IN_TTL_MS))).toEqual({ ok: false, reason: "time" });
    expect(check(build({ now: at(6 * 60_000) }))).toEqual({ ok: false, reason: "time" });
    const long = build().replace(/Expiration Time: .*/, `Expiration Time: ${at(SIGN_IN_TTL_MS + 1000).toISOString()}`);
    expect(check(long)).toEqual({ ok: false, reason: "time" });
    const noExpiry = build().replace(/\nExpiration Time: .*/, "");
    expect(check(noExpiry)).toEqual({ ok: false, reason: "malformed" });
    const notYet = `${build()}\nNot Before: ${at(60_000).toISOString()}`;
    expect(check(notYet)).toEqual({ ok: false, reason: "time" });
  });

  it("tolerates a wallet clock a little ahead of the server's", () => {
    expect(check(build({ now: at(60_000) }))).toMatchObject({ ok: true });
  });

  it("refuses anything that is not exactly an EIP-4361 message", () => {
    const message = build();
    const bad: unknown[] = [
      undefined,
      null,
      42,
      "",
      "hello",
      `${message}\n`,
      `${message}\nextra line`,
      `prefix ${message}`,
      message.replace(/\n/g, "\r\n"),
      message.replace("Version: 1", "Version: 2"),
      message.replace(NONCE, "short"),
      message.replace(NONCE, `${NONCE}!`),
      message.replace(/Issued At: .*/, "Issued At: yesterday"),
      message.replace(ACCOUNT.address, ACCOUNT.address.toLowerCase()),
      "x".repeat(MAX_MESSAGE_LENGTH + 1),
    ];
    for (const value of bad) {
      expect(check(value), JSON.stringify(value)?.slice(0, 80)).toMatchObject({ ok: false });
    }
  });
});
