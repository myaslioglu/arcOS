import { describe, expect, it, vi } from "vitest";
import { UserRejectedRequestError, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SIGN_IN_UNAVAILABLE, fetchSession, signInWithWallet, signOut } from "../sign-in-client";

const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const NONCE = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-09-30T12:00:00.000Z");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(answers: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected ${key}`);
    return answer();
  });
}

const run = (fetchImpl: ReturnType<typeof fakeFetch>, signMessage = ({ message }: { message: string }) => ACCOUNT.signMessage({ message })) =>
  signInWithWallet({
    address: ACCOUNT.address,
    chainId: 5042,
    signMessage,
    siteUrl: "https://4rcos.com",
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });

describe("signInWithWallet", () => {
  it("asks for a nonce, has the wallet sign the site's message, and sends it to verify", async () => {
    const fetchImpl = fakeFetch({
      "GET /api/auth/nonce": () => json(200, { nonce: NONCE }),
      "POST /api/auth/verify": () => json(200, { address: ACCOUNT.address.toLowerCase() }),
    });
    const outcome = await run(fetchImpl);
    expect(outcome).toEqual({ ok: true, address: ACCOUNT.address.toLowerCase() });

    const [, verifyInit] = fetchImpl.mock.calls[1]!;
    expect(verifyInit?.headers).toEqual({ "content-type": "application/json" });
    expect(verifyInit?.credentials).toBe("same-origin");
    const sent = JSON.parse(String(verifyInit?.body)) as { message: string; signature: Hex };
    const parsed = parseSiweMessage(sent.message);
    expect(parsed.domain).toBe("4rcos.com");
    expect(parsed.uri).toBe("https://4rcos.com");
    expect(parsed.nonce).toBe(NONCE);
    expect(parsed.chainId).toBe(5042);
    expect(sent.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it("says so when the wallet refuses, and sends nothing to verify", async () => {
    const fetchImpl = fakeFetch({ "GET /api/auth/nonce": () => json(200, { nonce: NONCE }) });
    const outcome = await run(fetchImpl, async () => {
      throw new UserRejectedRequestError(new Error("User rejected the request with a long wallet message"));
    });
    expect(outcome).toEqual({ ok: false, error: "You cancelled the request in your wallet." });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never shows the wallet's own error text", async () => {
    const fetchImpl = fakeFetch({ "GET /api/auth/nonce": () => json(200, { nonce: NONCE }) });
    const outcome = await run(fetchImpl, async () => {
      throw new Error("internal detail https://rpc.example/key");
    });
    expect(outcome).toEqual({ ok: false, error: "Your wallet couldn't sign the message. Try again." });
  });

  it("shows the server's own error when verify refuses, and a plain one when it answers junk", async () => {
    const refused = fakeFetch({
      "GET /api/auth/nonce": () => json(200, { nonce: NONCE }),
      "POST /api/auth/verify": () => json(401, { error: "This sign-in request expired. Try again." }),
    });
    expect(await run(refused)).toEqual({ ok: false, error: "This sign-in request expired. Try again." });

    const junk = fakeFetch({
      "GET /api/auth/nonce": () => json(200, { nonce: NONCE }),
      "POST /api/auth/verify": () => new Response("<html>", { status: 502 }),
    });
    expect(await run(junk)).toEqual({ ok: false, error: "Sign-in failed. Try again." });
  });

  it("stops at a nonce it can't use", async () => {
    const off = fakeFetch({ "GET /api/auth/nonce": () => json(503, { error: "Sign-in isn't available right now." }) });
    expect(await run(off)).toEqual({ ok: false, error: "Sign-in isn't available right now." });
    const bad = fakeFetch({ "GET /api/auth/nonce": () => json(200, { nonce: "../x" }) });
    expect(await run(bad)).toEqual({ ok: false, error: "Sign-in failed. Try again." });
  });

  it("does nothing without the site's address", async () => {
    const fetchImpl = fakeFetch({});
    const outcome = await signInWithWallet({
      address: ACCOUNT.address,
      chainId: 5042,
      signMessage: () => Promise.reject(new Error("not called")),
      siteUrl: undefined,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, error: SIGN_IN_UNAVAILABLE });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("fetchSession and signOut", () => {
  it("reads the session, or null when signed out", async () => {
    const signedIn = fakeFetch({ "GET /api/auth/me": () => json(200, { address: "0xabc", telegram: "unlinked" }) });
    await expect(fetchSession(signedIn as unknown as typeof fetch)).resolves.toEqual({ address: "0xabc", telegram: "unlinked" });
    const signedOut = fakeFetch({ "GET /api/auth/me": () => json(401, { error: "Not signed in." }) });
    await expect(fetchSession(signedOut as unknown as typeof fetch)).resolves.toBeNull();
  });

  it("reads 'unavailable' when sign-in is off or the request fails", async () => {
    const off = fakeFetch({ "GET /api/auth/me": () => json(503, { error: "x" }) });
    await expect(fetchSession(off as unknown as typeof fetch)).resolves.toBe("unavailable");
    const down = vi.fn(async () => {
      throw new TypeError("network");
    });
    await expect(fetchSession(down as unknown as typeof fetch)).resolves.toBe("unavailable");
  });

  it("signs out with a POST", async () => {
    const fetchImpl = fakeFetch({ "POST /api/auth/logout": () => new Response(null, { status: 204 }) });
    await signOut(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  });
});
