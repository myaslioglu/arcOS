import { describe, expect, it, vi } from "vitest";
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
const GRAND = "0x9999999999999999999999999999999999999999";
const BEACON = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const PLAIN = "0x63a9059cbb00"; // PUSH4 transfer · STOP
const MINTABLE = "0x6340c10f1900"; // PUSH4 mint(address,uint256) · STOP
const dex: DexConfig = { quoteTokens: [{ address: USDC, symbol: "USDC" }], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000] };
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** A 32-byte EIP-1967 slot value holding `address` in its low 20 bytes. */
const slotWith = (address: string) => `0x000000000000000000000000${address.slice(2)}`;
const cloneOf = (target: string) => `0x363d3d373d3d3d363d73${target.slice(2)}5af43d82803e903d91602b57fd5bf3`;

type Fake = {
  code?: Record<string, string>;
  storage?: Record<string, string>;
  reads?: Record<string, unknown>;
  blockNumberError?: Error;
  codeErrors?: Record<string, Error>;
  storageError?: Error;
};

function reader(f: Fake): ChainReader {
  return {
    getCode: async (a) => {
      const err = f.codeErrors?.[a.toLowerCase()];
      if (err) throw err;
      return (f.code?.[a.toLowerCase()] as `0x${string}` | undefined) ?? null;
    },
    getStorageAt: async (a, slot) => {
      if (f.storageError) throw f.storageError;
      return (f.storage?.[`${a.toLowerCase()}:${slot}`] as `0x${string}` | undefined) ?? null;
    },
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
    // Three holders, and the explorer's own holders_count agrees that's all of them; the pool and
    // the burn address are excluded, which leaves exactly one wallet to name.
    expect(find(r, "holders")).toMatchObject({ status: "warn", title: "The only wallet holds 30%" });
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

  it("never judges a clone by its own trampoline bytecode — and a target with genuinely no code is a fail, not a pass", async () => {
    const clone = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    const r = await run({ code: { [TOKEN]: clone }, reads: { [`${TOKEN}.owner()`]: OWNER } }); // implementation code missing (the read succeeded, empty)
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Clone points at an address with no code" });
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
      token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: 2 }),
    });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, holders);
    expect(find(r, "holders")).toMatchObject({ status: "fail", title: "All 2 wallets hold 50.4%" });
  });

  it("says unknown — not pass — when the owner's own code fetch fails at the network level", async () => {
    const r = await run({
      code: { [TOKEN]: MINTABLE },
      reads: { [`${TOKEN}.owner()`]: OWNER },
      codeErrors: { [OWNER]: new Error("ETIMEDOUT") },
    });
    expect(find(r, "ownership").status).toBe("unknown");
    expect(find(r, "privileges").status).toBe("unknown");
  });

  it("still resolves when a clone's implementation fetch rejects, marking proxy, ownership, privileges and prevrandao unknown", async () => {
    const clone = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    const r = await run({ code: { [TOKEN]: clone }, codeErrors: { [IMPL]: new Error("ETIMEDOUT") } });
    expect(find(r, "proxy")).toMatchObject({ status: "unknown", title: "Couldn't check whether this clone is upgradeable" });
    expect(find(r, "ownership").status).toBe("unknown");
    expect(find(r, "privileges").status).toBe("unknown");
    expect(find(r, "prevrandao").status).toBe("unknown");
  });

  it("ranks holders by value, not by the order the explorer returned them, across a full page", async () => {
    const holderAddr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
    const holders = explorer({
      topHolders: async () =>
        Array.from({ length: 12 }, (_, i) => ({ address: holderAddr(i + 1), isContract: false, name: null, value: BigInt(i + 1) })),
    });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, holders);
    expect(find(r, "holders")).toMatchObject({ status: "pass", title: "Top 10 wallets hold 7.5%" });
  });

  it("strips spoofing characters from a symbol read on-chain", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.symbol()`]: "US\u202eDC" } });
    expect(r.token.symbol).toBe("USDC");
  });

  // --- Part 1: counts ---

  it("computes counts by status alongside passed/total", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.owner()`]: ZERO, [`${TOKEN}.totalSupply()`]: 1000n } });
    const byStatus = (s: Finding["status"]) => r.findings.filter((f) => f.status === s).length;
    expect(r.counts).toEqual({ pass: byStatus("pass"), warn: byStatus("warn"), fail: byStatus("fail"), unknown: byStatus("unknown") });
    expect(r.counts.pass).toBe(r.passed);
    expect(r.counts.pass + r.counts.warn + r.counts.fail + r.counts.unknown).toBe(r.total);
  });

  // --- Part 2 item 2: an empty holder list is never "0%" ---

  it("says unknown, not 0%, when the holder list is empty but holders are known to exist", async () => {
    const ex = explorer({ topHolders: async () => [], token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: 50 }) });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders")).toMatchObject({ status: "unknown", title: "Couldn't check holder concentration" });
  });

  it("says unknown when the holder list is empty and holdersCount is itself unknown", async () => {
    const ex = explorer({ topHolders: async () => [], token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: null }) });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders").status).toBe("unknown");
  });

  it("stays unknown, not pass, even when the explorer's own holdersCount claims zero — supply > 0 guarantees at least one holder", async () => {
    const ex = explorer({ topHolders: async () => [], token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: 0 }) });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders")).toMatchObject({ status: "unknown", title: "Couldn't check holder concentration" });
  });

  // --- Part 2 item 3: code the engine never read must not earn passes ---

  it("treats a non-canonical delegatecall trampoline as unidentified, not as a clean pass", async () => {
    const trampoline = `0x73${IMPL.slice(2)}f400`; // PUSH20 impl · DELEGATECALL · STOP — not a canonical EIP-1167 clone
    const r = await run({ code: { [TOKEN]: trampoline, [IMPL]: MINTABLE } });
    const expected = { status: "unknown", title: "This contract forwards calls to code that couldn't be identified" };
    expect(find(r, "proxy")).toMatchObject(expected);
    expect(find(r, "privileges")).toMatchObject(expected);
    expect(find(r, "prevrandao")).toMatchObject(expected);
    // No owner function was found either, but the logic that would reveal one was never read —
    // that must not read as "confirmed no owner".
    expect(find(r, "ownership").status).toBe("unknown");
  });

  it("fails a canonical clone whose target is itself an upgradeable proxy, instead of trusting the clone's own pass", async () => {
    const clone = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    const r = await run({
      code: { [TOKEN]: clone, [IMPL]: PLAIN },
      storage: { [`${IMPL}:${IMPL_SLOT}`]: `0x000000000000000000000000${OWNER.slice(2)}` }, // IMPL is itself an upgradeable proxy
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Clone of an upgradeable proxy" });
    expect(find(r, "privileges")).toMatchObject({ status: "unknown", title: "Couldn't read the contract's logic" });
    expect(find(r, "prevrandao").status).toBe("unknown");
  });

  it("resolves one level past a clone's upgradeable-proxy target when that target's own implementation is readable", async () => {
    const clone = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    const r = await run({
      code: { [TOKEN]: clone, [IMPL]: PLAIN, [GRAND]: MINTABLE },
      storage: { [`${IMPL}:${IMPL_SLOT}`]: `0x000000000000000000000000${GRAND.slice(2)}` },
      reads: { [`${TOKEN}.owner()`]: OWNER },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Clone of an upgradeable proxy" });
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  // --- Part 2 item 4: a privileged function with no readable owner is not "can't be called" ---

  it("marks ownership and privileges unknown, not pass, when there's no owner function but privileged functions exist", async () => {
    const r = await run({ code: { [TOKEN]: MINTABLE } }); // owner()/getOwner() both revert -> Owner{kind:"none"}
    expect(find(r, "ownership")).toMatchObject({ status: "unknown", title: "No owner function, but the contract has privileged functions" });
    expect(find(r, "privileges")).toMatchObject({ status: "unknown", title: "Privileged functions found, but who can call them can't be read" });
  });

  it("still passes ownership and privileges when there's no owner function and nothing privileged", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN } });
    expect(find(r, "ownership")).toMatchObject({ status: "pass", title: "No owner function" });
    expect(find(r, "privileges")).toMatchObject({ status: "pass", title: "No privileged functions found" });
  });

  // --- Part 2 item 5: evidence from ABI and bytecode is combined ---

  it("scans bytecode for privileges even when the verified ABI is empty", async () => {
    const ex = explorer({ contract: async () => ({ verified: true, name: "T", abi: [], proxyType: null, implementations: [] }) });
    const r = await run({ code: { [TOKEN]: MINTABLE }, reads: { [`${TOKEN}.owner()`]: OWNER } }, ex);
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  // --- Part 2 item 6: guard() never publishes raw error text ---

  it("never leaks a raw error message — even one containing a URL — into the report", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("fetch failed: https://rpc.internal.example.com/secret?key=abc123");
    const r = await run({ code: { [TOKEN]: PLAIN }, storageError: boom });
    expect(JSON.stringify(r)).not.toContain("rpc.internal.example.com");
    expect(find(r, "proxy")).toMatchObject({ status: "unknown", detail: "This check couldn't run — the network didn't answer." });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("proxy"), boom);
    spy.mockRestore();
  });

  // --- Part 2 item 8: third-party numbers can't sink a report ---

  it("doesn't crash when the explorer's total_supply is malformed", async () => {
    const ex = explorer({ token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1.5e21", holdersCount: 3 }) });
    const r = await run({ code: { [TOKEN]: PLAIN } }, ex);
    expect(r.token.totalSupply).toBeNull();
    expect(find(r, "holders").status).toBe("unknown");
  });

  // --- Part 3: an LP pair with totalSupply() == 0 is unknown, not fail ---

  it("marks lp-lock unknown, not fail, when the v2 pair's LP totalSupply is zero", async () => {
    const reads = {
      [`${V2}.getPair(${TOKEN},${USDC})`]: PAIR,
      [`${USDC}.balanceOf(${PAIR})`]: 5_000_000_000n,
      [`${PAIR}.totalSupply()`]: 0n,
    };
    const r = await run({ code: { [TOKEN]: PLAIN }, reads }, explorer(), dex);
    expect(find(r, "lp-lock").status).toBe("unknown");
  });

  // --- Wave F item 1: a top-level EIP-1967 proxy is scored on its IMPLEMENTATION's code ---

  it("scores an EIP-1967 proxy on its implementation's code, not on its own trampoline", async () => {
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: MINTABLE },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) },
      reads: { [`${TOKEN}.owner()`]: OWNER },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Upgradeable proxy" });
    expect(find(r, "ownership")).toMatchObject({ status: "warn", title: "Owned by a wallet" });
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  it("gives a proxy over mintable logic exactly the statuses that same logic gets unproxied", async () => {
    // The brief's trigger, with the raw 20-byte address in the slot: a proxy must never earn the
    // "nothing privileged here" passes its own dispatcher-less bytecode would otherwise produce.
    const proxied = await run({ code: { [TOKEN]: PLAIN, [IMPL]: MINTABLE }, storage: { [`${TOKEN}:${IMPL_SLOT}`]: IMPL } });
    const bare = await run({ code: { [TOKEN]: MINTABLE } });
    for (const id of ["ownership", "privileges", "prevrandao"] as const) {
      expect([id, find(proxied, id).status, find(proxied, id).title]).toEqual([id, find(bare, id).status, find(bare, id).title]);
    }
    expect(find(proxied, "privileges").status).toBe("unknown");
  });

  it("uses the implementation's verified ABI for privileges, never the proxy's own", async () => {
    const ex = explorer({
      contract: async (a) =>
        a.toLowerCase() === IMPL.toLowerCase()
          ? { verified: true, name: "Logic", abi: [{ type: "function", name: "mint", stateMutability: "nonpayable" }], proxyType: null, implementations: [] }
          : { verified: true, name: "Proxy", abi: [], proxyType: null, implementations: [] },
    });
    const r = await run(
      {
        code: { [TOKEN]: PLAIN, [IMPL]: PLAIN }, // neither dispatcher mentions mint — only the ABI does
        storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) },
        reads: { [`${TOKEN}.owner()`]: OWNER },
      },
      ex,
    );
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  it("marks the logic-dependent checks unknown when a proxy's implementation code can't be read", async () => {
    const r = await run({
      code: { [TOKEN]: PLAIN },
      codeErrors: { [IMPL]: new Error("ETIMEDOUT") },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Upgradeable proxy" });
    expect(find(r, "ownership").status).toBe("unknown");
    expect(find(r, "privileges").status).toBe("unknown");
    expect(find(r, "prevrandao").status).toBe("unknown");
  });

  it("marks the logic-dependent checks unknown when a proxy's implementation slot points at empty code", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) } });
    expect(find(r, "privileges").status).toBe("unknown");
    expect(find(r, "prevrandao").status).toBe("unknown");
    expect(find(r, "ownership").status).toBe("unknown");
  });

  it("resolves a beacon proxy through beacon.implementation() and scores that code", async () => {
    const r = await run({
      code: { [TOKEN]: PLAIN, [BEACON]: PLAIN, [IMPL]: MINTABLE },
      storage: { [`${TOKEN}:${BEACON_SLOT}`]: slotWith(BEACON) },
      reads: { [`${BEACON}.implementation()`]: IMPL, [`${TOKEN}.owner()`]: OWNER },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Upgradeable proxy" });
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  it("never scores the beacon's own code when the beacon won't answer implementation()", async () => {
    const r = await run({
      code: { [TOKEN]: PLAIN, [BEACON]: PLAIN }, // the beacon itself has plain, unprivileged code
      storage: { [`${TOKEN}:${BEACON_SLOT}`]: slotWith(BEACON) },
    });
    expect(find(r, "privileges").status).toBe("unknown");
    expect(find(r, "prevrandao").status).toBe("unknown");
    expect(find(r, "ownership").status).toBe("unknown");
  });

  it("never scores the inner trampoline when a proxy's implementation is itself a clone", async () => {
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: cloneOf(GRAND), [GRAND]: MINTABLE },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) },
    });
    expect(find(r, "privileges").status).toBe("unknown");
    expect(find(r, "prevrandao").status).toBe("unknown");
    expect(find(r, "ownership").status).toBe("unknown");
  });

  it("never scores a beacon's own code when a clone's target is a beacon proxy", async () => {
    // The clone's target is an EIP-1967 BEACON proxy: the beacon address is not the logic, so its
    // own (unprivileged) code must never stand in for the implementation's.
    const r = await run({
      code: { [TOKEN]: cloneOf(IMPL), [IMPL]: PLAIN, [BEACON]: PLAIN, [GRAND]: MINTABLE },
      storage: { [`${IMPL}:${BEACON_SLOT}`]: slotWith(BEACON) },
      reads: { [`${BEACON}.implementation()`]: GRAND, [`${TOKEN}.owner()`]: OWNER },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Clone of an upgradeable proxy" });
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  // --- Wave F item 2: a failed storage read is never "the target is not a proxy" ---

  it("says unknown, not 'not upgradeable', when a clone target's EIP-1967 slots can't be read", async () => {
    const r = await run({ code: { [TOKEN]: cloneOf(IMPL), [IMPL]: PLAIN }, storageError: new Error("ETIMEDOUT") });
    expect(find(r, "proxy")).toMatchObject({ status: "unknown", title: "Couldn't check whether this clone is upgradeable" });
  });

  it("says unknown, not 'Not a proxy', when the token's own EIP-1967 slots can't be read", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run({ code: { [TOKEN]: PLAIN }, storageError: new Error("ETIMEDOUT") });
    expect(find(r, "proxy").status).toBe("unknown");
    spy.mockRestore();
  });

  // --- Wave F item 3: a truncated top-holder list is never a pass ---

  const threeHolders = [
    { address: OWNER, isContract: false, name: null, value: 80n },
    { address: GRAND, isContract: false, name: null, value: 80n },
    { address: "0x8888888888888888888888888888888888888888", isContract: false, name: null, value: 80n },
  ];
  const withHolders = (holdersCount: number | null) =>
    explorer({
      topHolders: async () => threeHolders,
      token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount }),
    });

  it("says unknown when the explorer returned fewer than ten holders but counts thousands", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, withHolders(5000));
    expect(find(r, "holders")).toMatchObject({ status: "unknown", title: "Couldn't check holder concentration" });
  });

  it("says unknown when a short holder list can't be confirmed complete", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, withHolders(null));
    expect(find(r, "holders").status).toBe("unknown");
  });

  it("passes a short holder list the explorer confirms is everyone, and counts the wallets truthfully", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, withHolders(3));
    expect(find(r, "holders")).toMatchObject({ status: "pass", title: "All 3 wallets hold 24%" });
  });

  // --- Wave F item 4: a renounced owner proves nothing about role holders ---

  // PUSH4 mint(address,uint256) · PUSH4 grantRole(bytes32,address) · STOP
  const MINT_AND_ROLES = "0x6340c10f19632f2ff15d00";

  it("never calls privileged functions uncallable when a renounced owner sits next to AccessControl", async () => {
    const r = await run({ code: { [TOKEN]: MINT_AND_ROLES }, reads: { [`${TOKEN}.owner()`]: ZERO } });
    expect(find(r, "ownership")).toMatchObject({ status: "warn", title: "Role-based admin" });
    expect(find(r, "ownership").detail).toMatch(/renounced/);
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  it("still reports plain role-based admin, with no owner function, the way it always did", async () => {
    const r = await run({ code: { [TOKEN]: MINT_AND_ROLES } });
    expect(find(r, "ownership")).toMatchObject({ status: "warn", title: "Role-based admin", detail: "Uses AccessControl; role holders can't be listed from bytecode." });
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
  });

  // --- Wave F small items: a fail needs an explicit negative; a pool claim needs an answer ---

  it("says unknown, not 'source code isn't verified', when the explorer has no record of the address", async () => {
    const ex = explorer({ contract: async () => ({ verified: null, name: null, abi: null, proxyType: null, implementations: [] }) });
    const r = await run({ code: { [TOKEN]: PLAIN } }, ex);
    expect(find(r, "verified")).toMatchObject({ status: "unknown", detail: "The explorer has no record of this contract yet." });
  });

  it("still fails verification when the explorer positively says the source isn't verified", async () => {
    const ex = explorer({ contract: async () => ({ verified: false, name: null, abi: null, proxyType: null, implementations: [] }) });
    const r = await run({ code: { [TOKEN]: PLAIN } }, ex);
    expect(find(r, "verified")).toMatchObject({ status: "fail", title: "Source code isn't verified" });
  });

  it("says unknown, not 'no pool found', when every DEX factory call reverts", async () => {
    // No `reads` entry for either factory: every call reverts, which is what a factory address
    // with no contract code on this network does.
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, explorer(), dex);
    expect(find(r, "liquidity")).toMatchObject({ status: "unknown", title: "Couldn't read liquidity pools" });
    expect(find(r, "lp-lock").status).toBe("unknown");
    expect(find(r, "lp-lock").detail).not.toMatch(/No pool was found/);
  });

  it("still warns 'no pool found' when the factories answer that there is no pair", async () => {
    const reads = {
      [`${TOKEN}.totalSupply()`]: 1000n,
      [`${V2}.getPair(${TOKEN},${USDC})`]: ZERO,
      [`${V3}.getPool(${TOKEN},${USDC},3000)`]: ZERO,
    };
    const r = await run({ code: { [TOKEN]: PLAIN }, reads }, explorer(), dex);
    expect(find(r, "liquidity")).toMatchObject({ status: "warn", title: "No Uniswap v2 or v3 pool found" });
  });

  // --- Wave F audit: "renounced" is only half the story when the logic was never read ---

  it("says unknown, not 'ownership is renounced', when the logic behind a proxy was never read", async () => {
    // owner() answers with a burn address, but the implementation's code — the only place a
    // grantRole selector could be seen — couldn't be fetched, so "nobody controls this" isn't
    // something this run can tell.
    const r = await run({
      code: { [TOKEN]: PLAIN },
      codeErrors: { [IMPL]: new Error("ETIMEDOUT") },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) },
      reads: { [`${TOKEN}.owner()`]: ZERO },
    });
    expect(find(r, "ownership")).toMatchObject({ status: "unknown" });
    expect(find(r, "ownership").detail).toMatch(/burn address/);
  });

  // --- Part 3: the inspected address is always checksummed ---

  it("checksums the inspected address regardless of the casing passed in", async () => {
    const r = await inspect({
      address: DEAD as `0x${string}`, // all-lowercase input
      network: "testnet",
      reader: reader({ code: { [DEAD]: PLAIN } }),
      explorer: null,
      dex: null,
      knownLockers: [],
      explorerBase: "https://explorer.test",
    });
    expect(r.address).toBe("0x000000000000000000000000000000000000dEaD");
  });
});
