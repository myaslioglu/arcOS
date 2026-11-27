/**
 * Sourcify, the open verification repository: whether a contract's runtime code has verified source there. No key. The
 * server asks it about chains other than Arc (`InspectChain.sourcify`), where most sources are verified on Etherscan,
 * which Inspector doesn't read, and Blockscout may not hold them all: a match here is evidence Blockscout can miss.
 */

/** Whether a contract's code is verified somewhere: `verified` resolves true or false, and rejects when nobody could tell. */
export interface VerificationSource {
  verified(address: string): Promise<boolean>;
}

export class SourcifyUnavailable extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "Sourcify didn't answer" : `Sourcify answered ${status}`);
    this.name = "SourcifyUnavailable";
  }
}

export const SOURCIFY_SERVER = "https://sourcify.dev/server";

/** Where a person can read the verified source Sourcify holds for a contract: the repository's page for it. */
export const sourcifyPageUrl = (chainId: number, address: string): string => `https://repo.sourcify.dev/${chainId}/${address}`;

/** How long one request may take before it counts as no answer. */
const REQUEST_TIMEOUT_MS = 5_000;

/** A runtime match: Sourcify's "exact_match" (the metadata too) or "match" (the bytecode, with other metadata). */
const RUNTIME_MATCHES = new Set(["exact_match", "match"]);

/**
 * Sourcify's v2 lookup, `GET /v2/contract/{chainId}/{address}`, as measured on 2026-11-27: a contract it has answers 200
 * with `runtimeMatch` "exact_match" or "match"; one it doesn't answers 404 with every match field null. Only a runtime
 * match counts, since what matters is the code that runs: a 200 without one is "no match" too. Anything else (another
 * status, a body that isn't JSON, a timeout, a failed request) rejects with `SourcifyUnavailable`: nobody could tell.
 * `signal` ends the request early, as the inspection's deadline does.
 */
export function sourcifySource(chainId: number, options: { fetchFn?: typeof fetch; signal?: AbortSignal; server?: string } = {}): VerificationSource {
  const { fetchFn = fetch, signal, server = SOURCIFY_SERVER } = options;
  return {
    async verified(address) {
      let res: Response;
      try {
        const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])];
        res = await fetchFn(`${server}/v2/contract/${chainId}/${address}`, { headers: { accept: "application/json" }, signal: AbortSignal.any(signals) });
      } catch {
        throw new SourcifyUnavailable(null);
      }
      if (res.status !== 200 && res.status !== 404) throw new SourcifyUnavailable(res.status);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new SourcifyUnavailable(res.status);
      }
      if (typeof body !== "object" || body === null) throw new SourcifyUnavailable(res.status);
      if (res.status === 404) return false;
      const match = (body as { runtimeMatch?: unknown }).runtimeMatch;
      return typeof match === "string" && RUNTIME_MATCHES.has(match);
    },
  };
}
