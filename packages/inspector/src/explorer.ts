import { cleanLabel } from "./label";

export class ExplorerUnavailable extends Error {
  constructor(
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ExplorerUnavailable";
  }
}

export type ContractInfo = {
  /** `null` when the explorer has no record of this address (a 404), or answered without saying
   * either way — which is not the same claim as "this contract's source isn't verified". */
  verified: boolean | null;
  name: string | null;
  abi: readonly unknown[] | null;
  proxyType: string | null;
  implementations: string[];
};
export type TokenInfo = {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  holdersCount: number | null;
};
export type Holder = { address: string; isContract: boolean; name: string | null; value: bigint };

/**
 * One page of a token's holder list, and whether the explorer said it is the WHOLE list. Blockscout
 * pages this endpoint 50 rows at a time and sends `next_page_params: null` on the last page — the
 * only positive statement it makes about completeness that doesn't depend on its `holders_count`
 * field being fresh. A share added up from an unknown fraction of the holders isn't a concentration
 * figure, so `checkHolders` needs to know which of the two it has.
 */
export type HolderPage = { holders: Holder[]; complete: boolean };
export type TokenBalance = { address: string; name: string | null; symbol: string | null; decimals: number; value: bigint };

export interface ExplorerSource {
  contract(address: string): Promise<ContractInfo>;
  token(address: string): Promise<TokenInfo | null>;
  /** null means the explorer has no holder list for this token (404) — never treat that as "zero holders". */
  topHolders(address: string): Promise<HolderPage | null>;
  tokenBalances(address: string): Promise<TokenBalance[]>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const big = (v: unknown): bigint => {
  try {
    const n = BigInt(typeof v === "string" || typeof v === "number" ? v : 0);
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
};

export function blockscoutSource(apiUrl: string, fetchFn: typeof fetch = fetch): ExplorerSource {
  /** null = 404. Anything else that isn't a 2xx JSON answer is an outage. */
  async function get(path: string): Promise<unknown | null> {
    let res: Response;
    try {
      res = await fetchFn(`${apiUrl}${path}`, { headers: { accept: "application/json" } });
    } catch (e) {
      throw new ExplorerUnavailable(null, `Explorer unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new ExplorerUnavailable(res.status, `Explorer answered ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ExplorerUnavailable(res.status, "Explorer sent something that isn't JSON");
    }
  }

  return {
    async contract(address) {
      const j = (await get(`/smart-contracts/${address}`)) as Json | null;
      const impls = j && Array.isArray(j.implementations) ? (j.implementations as unknown[]) : [];
      const info: ContractInfo = j
        ? {
            // Only an explicit boolean is evidence: a body without the field is the explorer
            // declining to say, and "it didn't say" must never be rendered as "it said no".
            verified: typeof j.is_verified === "boolean" ? j.is_verified : null,
            name: cleanLabel(str(j.name), 64),
            abi: Array.isArray(j.abi) ? (j.abi as unknown[]) : null,
            proxyType: str(j.proxy_type),
            implementations: impls
              .map((i) => str(obj(i).address_hash) ?? str(obj(i).address))
              .filter((a): a is string => a !== null),
          }
        : { verified: null, name: null, abi: null, proxyType: null, implementations: [] };
      if (info.verified !== null) return info;

      // Measured on the real testnet explorer (2026-09-20): an unverified contract's
      // /smart-contracts/<addr> answers 200 with NO `is_verified` field at all — not a 404, and not
      // `is_verified: false`. That is NOT the explorer declining to say; /addresses/<addr> has its
      // own explicit `is_verified` for the same address, so ask it before giving up and calling
      // this "unknown". Only trusted when it's unambiguously about a contract at this address
      // (`is_contract: true`) and itself carries a boolean — a 404, "not a contract", or another
      // body with no boolean all still mean "the explorer never said either way".
      let a: Json | null;
      try {
        a = (await get(`/addresses/${address}`)) as Json | null;
      } catch (e) {
        // An outage on this second call must not sink whatever the first call already produced
        // (abi, implementations, ...) — it only means `verified` stays unknown, same as a 404.
        if (e instanceof ExplorerUnavailable) return info;
        throw e;
      }
      if (a && a.is_contract === true && typeof a.is_verified === "boolean") {
        return { ...info, verified: a.is_verified };
      }
      return info;
    },
    async token(address) {
      const j = (await get(`/tokens/${address}`)) as Json | null;
      if (!j) return null;
      return {
        name: cleanLabel(str(j.name), 64),
        symbol: cleanLabel(str(j.symbol), 32),
        decimals: int(j.decimals),
        totalSupply: str(j.total_supply),
        holdersCount: int(j.holders_count),
      };
    },
    async topHolders(address) {
      const j = (await get(`/tokens/${address}/holders`)) as Json | null;
      if (!j) return null;
      const items = Array.isArray(j.items) ? (j.items as unknown[]) : [];
      const holders = items.flatMap((raw) => {
        const it = obj(raw);
        const a = obj(it.address);
        const hash = str(a.hash);
        return hash ? [{ address: hash, isContract: a.is_contract === true, name: cleanLabel(str(a.name), 64), value: big(it.value) }] : [];
      });
      // Only an explicit `null` is the explorer saying "this page is the last one". A body without
      // the field at all hasn't said so, and an absent statement is never a positive one.
      return { holders, complete: "next_page_params" in j && j.next_page_params === null };
    },
    async tokenBalances(address) {
      const j = await get(`/addresses/${address}/token-balances`);
      const items = Array.isArray(j) ? (j as unknown[]) : [];
      return items.flatMap((raw) => {
        const it = obj(raw);
        const t = obj(it.token);
        const hash = str(t.address_hash) ?? str(t.address);
        const decimals = int(t.decimals);
        if (t.type !== "ERC-20" || !hash || decimals === null) return [];
        return [{ address: hash, name: cleanLabel(str(t.name), 64), symbol: cleanLabel(str(t.symbol), 32), decimals, value: big(it.value) }];
      });
    },
  };
}
