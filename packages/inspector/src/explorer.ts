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
  verified: boolean;
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
export type TokenBalance = { address: string; name: string | null; symbol: string | null; decimals: number; value: bigint };

export interface ExplorerSource {
  contract(address: string): Promise<ContractInfo>;
  token(address: string): Promise<TokenInfo | null>;
  /** null means the explorer has no holder list for this token (404) — never treat that as "zero holders". */
  topHolders(address: string): Promise<Holder[] | null>;
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
      if (!j) return { verified: false, name: null, abi: null, proxyType: null, implementations: [] };
      const impls = Array.isArray(j.implementations) ? (j.implementations as unknown[]) : [];
      return {
        verified: j.is_verified === true,
        name: cleanLabel(str(j.name), 64),
        abi: Array.isArray(j.abi) ? (j.abi as unknown[]) : null,
        proxyType: str(j.proxy_type),
        implementations: impls
          .map((i) => str(obj(i).address_hash) ?? str(obj(i).address))
          .filter((a): a is string => a !== null),
      };
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
      return items.flatMap((raw) => {
        const it = obj(raw);
        const a = obj(it.address);
        const hash = str(a.hash);
        return hash ? [{ address: hash, isContract: a.is_contract === true, name: cleanLabel(str(a.name), 64), value: big(it.value) }] : [];
      });
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
