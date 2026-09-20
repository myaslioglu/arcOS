import { describe, expect, it } from "vitest";
import type { DexConfig } from "@arcos/chain";
import { ExplorerUnavailable, type ExplorerSource } from "../explorer";
import { NotAContract, inspect } from "../inspect";
import { CallReverted, type ChainReader, type Finding, type Report } from "../types";

const TOKEN = "0x1111111111111111111111111111111111111111";
const IMPL = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";
const PAIR = "0x4444444444444444444444444444444444444444";
const USDC = "0x3600000000000000000000000000000000000000";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const V2 = "0x5555555555555555555555555555555555555555";
const V3 = "0x6666666666666666666666666666666666666666";

const PLAIN = "0x63a9059cbb00"; // PUSH4 transfer · STOP
const MINTABLE = "0x6340c10f1900"; // PUSH4 mint(address,uint256) · STOP
const dex: DexConfig = { quoteTokens: [{ address: USDC, symbol: "USDC" }], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000] };

type Fake = {
  code?: Record<string, string>;
  storage?: Record<string, string>;
  reads?: Record<string, unknown>;
  blockNumberError?: Error;
  codeErrors?: Record<string, Error>;
};

function reader(f: Fake): ChainReader {
  return {
    getCode: async (a) => {
      const err = f.codeErrors?.[a.toLowerCase()];
      if (err) throw err;
      return (f.code?.[a.toLowerCase()] as `0x${string}` | undefined) ?? null;
    },
    getStorageAt: async (a, slot) => (f.storage?.[`${a.toLowerCase()}:${slot}`] as `0x${string}` | undefined) ?? null,
    read: async (a, _abi, fn, args = []) => {
      const key = `${a.toLowerCase()}.${fn}(${args.map((x) => String(x).toLowerCase()).join(",")})`;
      if (!f.reads || !(key in f.reads)) throw new CallReverted();
      const value = f.reads[key];
      if (value instanceof Error) throw value;
      return value;
    },
    blockNumber: async () => {
      if (f.blockNumberError) throw f.blockNumberError;
      return 123n;
    },
  };
}

const explorer = (over: Partial<ExplorerSource> = {}): ExplorerSource => ({
  contract: async () => ({ verified: true, name: "T", abi: null, proxyType: null, implementations: [] }),
  token: async () => ({ name: "Token", symbol: "TKN", decimals: 18, totalSupply: "1000", holdersCount: 3 }),
  topHolders: async () => [],
  tokenBalances: async () => [],
  ...over,
});

const run = (f: Fake, ex: ExplorerSource | null = explorer(), d: DexConfig | null = null): Promise<Report> =>
  inspect({
    address: TOKEN, network: "testnet", reader: reader(f), explorer: ex, dex: d, knownLockers: [],
    explorerBase: "https://explorer.test", now: () => new Date("2026-09-20T00:00:00Z"),
  });

const find = (r: Report, id: Finding["id"]) => r.findings.find((x) => x.id === id)!;

describe("inspect", () => {
  it("rejects an address with no code", async () => {
    await expect(run({})).rejects.toBeInstanceOf(NotAContract);
  });

  it("reports a plain renounced token as clean where it can tell", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.owner()`]: ZERO, [`${TOKEN}.totalSupply()`]: 1000n } });
    expect(find(r, "ownership").status).toBe("pass");
    expect(find(r, "privileges").status).toBe("pass");
    expect(find(r, "proxy").status).toBe("pass");
    expect(find(r, "prevrandao").status).toBe("pass");
    expect(find(r, "verified").status).toBe("pass");
    expect(r.total).toBe(8);
    expect(r.passed).toBe(r.findings.filter((x) => x.status === "pass").length);
    expect(r.generatedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(JSON.stringify(r)).toContain(TOKEN); // JSON-safe: no bigint anywhere
  });

  it("fails privileges when an owner can mint", async () => {
    const r = await run({ code: { [TOKEN]: MINTABLE }, reads: { [`${TOKEN}.owner()`]: OWNER } });
    expect(find(r, "ownership")).toMatchObject({ status: "warn", title: "Owned by a wallet" });
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  it("passes privileges when the mint function exists but ownership is renounced", async () => {
    const r = await run({ code: { [TOKEN]: MINTABLE }, reads: { [`${TOKEN}.owner()`]: DEAD } });
    expect(find(r, "privileges").status).toBe("pass");
    expect(find(r, "privileges").detail).toMatch(/renounced/);
  });

  it("reads privileges through an EIP-1167 clone and calls it non-upgradeable", async () => {
    const clone = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    const r = await run({ code: { [TOKEN]: clone, [IMPL]: MINTABLE }, reads: { [`${TOKEN}.owner()`]: OWNER } });
    expect(find(r, "proxy")).toMatchObject({ status: "pass", title: "Minimal proxy — not upgradeable" });
    expect(find(r, "privileges").status).toBe("fail");
  });

  it("fails an EIP-1967 proxy", async () => {
    const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: PLAIN },
      storage: { [`${TOKEN}:${slot}`]: `0x000000000000000000000000${IMPL.slice(2)}` },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Upgradeable proxy" });
  });

  it("warns on PREVRANDAO", async () => {
    const r = await run({ code: { [TOKEN]: "0x4400" } });
    expect(find(r, "prevrandao").status).toBe("warn");
  });

  it("marks explorer-backed checks unknown when the explorer is down, and keeps the rest", async () => {
    const down = explorer({
      contract: async () => { throw new ExplorerUnavailable(403, "challenge"); },
      topHolders: async () => { throw new ExplorerUnavailable(403, "challenge"); },
      token: async () => { throw new ExplorerUnavailable(403, "challenge"); },
    });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.owner()`]: ZERO } }, down);
    expect(find(r, "verified").status).toBe("unknown");
    expect(find(r, "holders").status).toBe("unknown");
    expect(find(r, "ownership").status).toBe("pass");
    expect(r.explorerReachable).toBe(false);
  });

  it("measures holder concentration without pools and burn addresses", async () => {
    const holders = explorer({
      topHolders: async () => [
        { address: PAIR, isContract: true, name: null, value: 500n },
        { address: DEAD, isContract: false, name: null, value: 100n },
        { address: OWNER, isContract: false, name: null, value: 300n },
      ],
    });
    const reads = {
      [`${TOKEN}.totalSupply()`]: 1000n,
      [`${V2}.getPair(${TOKEN},${USDC})`]: PAIR,
      [`${V3}.getPool(${TOKEN},${USDC},3000)`]: ZERO,
      [`${USDC}.balanceOf(${PAIR})`]: 5_000_000_000n,
      [`${PAIR}.totalSupply()`]: 100n,
      [`${PAIR}.balanceOf(${ZERO})`]: 0n,
      [`${PAIR}.balanceOf(${DEAD})`]: 100n,
    };
    const r = await run({ code: { [TOKEN]: PLAIN }, reads }, holders, dex);
    expect(find(r, "holders")).toMatchObject({ status: "warn", title: "Top 10 wallets hold 30%" });
    expect(find(r, "liquidity").status).toBe("pass");
    expect(find(r, "lp-lock")).toMatchObject({ status: "pass", fixAppId: null });
  });

  it("fails lp-lock with a Vault fix when v2 LP sits in wallets", async () => {
    const reads = {
      [`${V2}.getPair(${TOKEN},${USDC})`]: PAIR,
      [`${V3}.getPool(${TOKEN},${USDC},3000)`]: ZERO,
      [`${USDC}.balanceOf(${PAIR})`]: 5_000_000_000n,
      [`${PAIR}.totalSupply()`]: 100n,
      [`${PAIR}.balanceOf(${ZERO})`]: 0n,
      [`${PAIR}.balanceOf(${DEAD})`]: 10n,
    };
    const r = await run({ code: { [TOKEN]: PLAIN }, reads }, explorer(), dex);
    expect(find(r, "lp-lock")).toMatchObject({ status: "fail", fixAppId: "vault" });
  });

  it("says unknown, not fail, where it has no DEX config", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN } });
    expect(find(r, "liquidity").status).toBe("unknown");
    expect(find(r, "lp-lock").status).toBe("unknown");
  });

  it("says unknown — not pass — when the owner read fails at the network level", async () => {
    const r = await run({ code: { [TOKEN]: MINTABLE }, reads: { [`${TOKEN}.owner()`]: new Error("ETIMEDOUT"), [`${TOKEN}.getOwner()`]: new Error("ETIMEDOUT") } });
    expect(find(r, "ownership").status).toBe("unknown");
    expect(find(r, "privileges").status).toBe("unknown");
  });

  it("still passes privileges with an unknown owner when there is nothing privileged to call", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.owner()`]: new Error("ETIMEDOUT"), [`${TOKEN}.getOwner()`]: new Error("ETIMEDOUT") } });
    expect(find(r, "ownership").status).toBe("unknown");
    expect(find(r, "privileges").status).toBe("pass");
  });

  it("never judges a clone by its own trampoline bytecode", async () => {
    const clone = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    const r = await run({ code: { [TOKEN]: clone }, reads: { [`${TOKEN}.owner()`]: OWNER } }); // implementation code missing
    expect(find(r, "proxy").status).toBe("pass");
    expect(find(r, "privileges").status).toBe("unknown");
    expect(find(r, "prevrandao").status).toBe("unknown");
  });

  it("survives a failing blockNumber call", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, blockNumberError: new Error("boom") });
    expect(r.blockNumber).toBe("unknown");
    expect(r.total).toBe(8);
  });

  it("says unknown when pool discovery fails at the network level", async () => {
    const reads = { [`${V2}.getPair(${TOKEN},${USDC})`]: new Error("ETIMEDOUT"), [`${TOKEN}.totalSupply()`]: 1000n };
    const r = await run({ code: { [TOKEN]: PLAIN }, reads }, explorer(), dex);
    expect(find(r, "liquidity").status).toBe("unknown");
    expect(find(r, "lp-lock").status).toBe("unknown");
    expect(find(r, "holders").status).toBe("unknown");
  });

  it("says unknown when an LP balance read fails at the network level", async () => {
    const reads = {
      [`${V2}.getPair(${TOKEN},${USDC})`]: PAIR,
      [`${USDC}.balanceOf(${PAIR})`]: 5_000_000_000n,
      [`${PAIR}.totalSupply()`]: 100n,
      [`${PAIR}.balanceOf(${ZERO})`]: new Error("ETIMEDOUT"),
      [`${PAIR}.balanceOf(${DEAD})`]: 100n,
    };
    const r = await run({ code: { [TOKEN]: PLAIN }, reads }, explorer(), dex);
    expect(find(r, "lp-lock").status).toBe("unknown");
  });

  it("offers no fix on an lp-lock it couldn't check", async () => {
    const POOL3 = "0x7777777777777777777777777777777777777777";
    const reads = { [`${V3}.getPool(${TOKEN},${USDC},3000)`]: POOL3, [`${USDC}.balanceOf(${POOL3})`]: 5_000_000_000n };
    const r = await run({ code: { [TOKEN]: PLAIN }, reads }, explorer(), dex);
    expect(find(r, "lp-lock")).toMatchObject({ status: "unknown", fixAppId: null });
  });

  it("ranks holders itself and shows one decimal when it matters", async () => {
    const holders = explorer({
      topHolders: async () => [
        { address: "0x8888888888888888888888888888888888888888", isContract: false, name: null, value: 4n },
        { address: OWNER, isContract: false, name: null, value: 500n },
      ],
    });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, holders);
    expect(find(r, "holders")).toMatchObject({ status: "fail", title: "Top 10 wallets hold 50.4%" });
  });
});
