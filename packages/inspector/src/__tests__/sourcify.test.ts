import { describe, expect, it } from "vitest";
import { SOURCIFY_SERVER, SourcifyUnavailable, sourcifyPageUrl, sourcifySource } from "../sourcify";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** A fetch that answers every request with `status` and `body` (a string is sent as it is), recording what it was asked. */
function answering(status: number, body: unknown) {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { asked, fetchFn };
}

// The answers as Sourcify's v2 lookup gave them on 2026-11-27 (docs/INSPECTOR-CHAINS.md).
const EXACT = { matchId: "618412", creationMatch: "exact_match", runtimeMatch: "exact_match", verifiedAt: "2024-08-08T11:41:08Z", match: "exact_match", chainId: "42161", address: USDC };
const PARTIAL = { matchId: "1532018", creationMatch: "match", runtimeMatch: "match", verifiedAt: "2024-08-08T13:20:07Z", match: "match", chainId: "1", address: USDC };
const NONE = { match: null, creationMatch: null, runtimeMatch: null, chainId: "1", address: USDC };

describe("sourcifySource", () => {
  it("asks the v2 lookup for the chain and the address, as JSON", async () => {
    const { asked, fetchFn } = answering(200, EXACT);
    await sourcifySource(42161, { fetchFn }).verified(USDC);
    expect(asked[0]!.url).toBe(`${SOURCIFY_SERVER}/v2/contract/42161/${USDC}`);
    expect(new Headers(asked[0]!.init?.headers).get("accept")).toBe("application/json");
    expect(asked[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("counts a runtime match, exact or not, as verified", async () => {
    expect(await sourcifySource(42161, answering(200, EXACT)).verified(USDC)).toBe(true);
    expect(await sourcifySource(1, answering(200, PARTIAL)).verified(USDC)).toBe(true);
  });

  it("reads its 404 as no match, and so a record without a runtime match", async () => {
    expect(await sourcifySource(1, answering(404, NONE)).verified(USDC)).toBe(false);
    // A creation match alone says nothing about the code that runs.
    expect(await sourcifySource(1, answering(200, { ...PARTIAL, runtimeMatch: null })).verified(USDC)).toBe(false);
    expect(await sourcifySource(1, answering(200, { ...PARTIAL, runtimeMatch: "something_else" })).verified(USDC)).toBe(false);
  });

  it("rejects when nobody can tell: another status, a body that isn't JSON, a failed request", async () => {
    for (const [status, body] of [[500, "oops"], [429, { error: "slow down" }], [400, { customCode: "invalid_parameter" }], [200, "not json"], [200, "null"]] as const) {
      await expect(sourcifySource(1, answering(status, body)).verified(USDC), `${status} ${String(body)}`).rejects.toBeInstanceOf(SourcifyUnavailable);
    }
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(sourcifySource(1, { fetchFn: failing }).verified(USDC)).rejects.toMatchObject({ name: "SourcifyUnavailable", status: null });
  });

  it("stops when the caller's signal does, and says nothing it didn't hear", async () => {
    const controller = new AbortController();
    const hanging = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const pending = sourcifySource(1, { fetchFn: hanging, signal: controller.signal }).verified(USDC);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(SourcifyUnavailable);
  });

  it("links a contract's page in Sourcify's repository", () => {
    expect(sourcifyPageUrl(8453, USDC)).toBe(`https://repo.sourcify.dev/8453/${USDC}`);
  });
});
