import { describe, expect, it, vi } from "vitest";
import type { DexConfig } from "@arcos/chain";
import { extractSelectors } from "../bytecode";
import { ExplorerUnavailable, blockscoutSource, type ExplorerSource, type Holder } from "../explorer";
import { NotAContract, inspect } from "../inspect";
import { CallReverted, type ChainReader, type Finding, type Report } from "../types";
import { MINTABLE_TOKEN_DEPLOYED, STANDARD_TOKEN_DEPLOYED } from "./fixtures/tokens";

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
// PUSH4 transfer · PUSH4 mint(address,uint256) · STOP. The transfer selector is what makes this a
// readable ERC-20 dispatcher rather than four bytes of something (see R2 / `dispatcherVisible`):
// without it no absence could be claimed from this fixture, and every case below is about what the
// presence of `mint` means, not about whether the scan could read the contract at all.
const MINTABLE = "0x63a9059cbb6340c10f1900";
const dex: DexConfig = { quoteTokens: [{ address: USDC, symbol: "USDC" }], v2Factory: V2, v3Factory: V3, v3FeeTiers: [3000] };
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
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
  /** A failure for ONE `address:slot` pair, keyed like `storage` — `storageError` fails every
   * storage read, which can't express "the implementation slot answered but the admin slot didn't". */
  storageErrors?: Record<string, Error>;
};

function reader(f: Fake): ChainReader {
  return {
    getCode: async (a) => {
      const err = f.codeErrors?.[a.toLowerCase()];
      if (err) throw err;
      return (f.code?.[a.toLowerCase()] as `0x${string}` | undefined) ?? null;
    },
    getStorageAt: async (a, slot) => {
      const key = `${a.toLowerCase()}:${slot}`;
      const err = f.storageErrors?.[key];
      if (err) throw err;
      if (f.storageError) throw f.storageError;
      return (f.storage?.[key] as `0x${string}` | undefined) ?? null;
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

/** One page of holders. `complete` defaults to false — the explorer only confirms a page is the
 * whole list by sending `next_page_params: null`, and most of the cases below are about what can
 * be said when it hasn't confirmed that. */
const page = (holders: Holder[], complete = false) => async () => ({ holders, complete });

const explorer = (over: Partial<ExplorerSource> = {}): ExplorerSource => ({
  contract: async () => ({ verified: true, name: "T", abi: null, proxyType: null, implementations: [] }),
  token: async () => ({ name: "Token", symbol: "TKN", decimals: 18, totalSupply: "1000", holdersCount: 3 }),
  topHolders: page([]),
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
      topHolders: page([
        { address: PAIR, isContract: true, name: null, value: 500n },
        { address: DEAD, isContract: false, name: null, value: 100n },
        { address: OWNER, isContract: false, name: null, value: 300n },
      ]),
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
      topHolders: page([
        { address: "0x8888888888888888888888888888888888888888", isContract: false, name: null, value: 4n },
        { address: OWNER, isContract: false, name: null, value: 500n },
      ]),
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
      topHolders: page(Array.from({ length: 12 }, (_, i) => ({ address: holderAddr(i + 1), isContract: false, name: null, value: BigInt(i + 1) }))),
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
    const ex = explorer({ topHolders: page([]), token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: 50 }) });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders")).toMatchObject({ status: "unknown", title: "Couldn't check holder concentration" });
  });

  it("says unknown when the holder list is empty and holdersCount is itself unknown", async () => {
    const ex = explorer({ topHolders: page([]), token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: null }) });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders").status).toBe("unknown");
  });

  it("stays unknown, not pass, even when the explorer's own holdersCount claims zero — supply > 0 guarantees at least one holder", async () => {
    const ex = explorer({ topHolders: page([]), token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: 0 }) });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders")).toMatchObject({ status: "unknown", title: "Couldn't check holder concentration" });
  });

  // --- Part 2 item 3: code the engine never read must not earn passes ---

  it("treats a non-canonical delegatecall trampoline as unidentified, not as a clean pass", async () => {
    const trampoline = `0x73${IMPL.slice(2)}f400`; // PUSH20 impl · DELEGATECALL · STOP — not a canonical EIP-1167 clone
    const r = await run({ code: { [TOKEN]: trampoline, [IMPL]: MINTABLE } });
    expect(find(r, "proxy")).toMatchObject({ status: "unknown", title: "This contract forwards calls to code that couldn't be identified" });
    // No owner function and nothing privileged was found either, but all three findings would rest
    // on a dispatcher this contract doesn't have, in front of code it runs but this scan can't see.
    for (const id of ["ownership", "privileges", "prevrandao"] as const) {
      expect([id, find(r, id).status]).toEqual([id, "unknown"]);
      expect([id, find(r, id).title]).toEqual([id, "Runs code this check can't see"]);
    }
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

  // Wave H, R1: replaces wave F's "gives a proxy over mintable logic exactly the statuses that same
  // logic gets unproxied". Identical statuses was the wrong invariant — the logic behind a proxy
  // can be swapped for different logic, so a pass the bare contract earns can't survive proxying.
  // What must hold is that proxying never makes a logic finding MORE reassuring, and never leaves
  // a pass standing.
  it("never gives a proxied token a better logic finding than the same logic unproxied, and never a pass", async () => {
    const REASSURANCE: Record<Finding["status"], number> = { pass: 3, warn: 2, unknown: 2, fail: 1 };
    // Second case keeps wave F's raw 20-byte slot value (not zero-padded to 32 bytes), which is
    // what `addressFromSlot` has to cope with either way.
    const cases = [
      { reads: {}, slot: slotWith(IMPL) },
      { reads: { [`${TOKEN}.owner()`]: OWNER }, slot: IMPL },
    ];
    for (const { reads, slot } of cases) {
      const proxied = await run({ code: { [TOKEN]: PLAIN, [IMPL]: MINTABLE }, storage: { [`${TOKEN}:${IMPL_SLOT}`]: slot }, reads });
      const bare = await run({ code: { [TOKEN]: MINTABLE }, reads });
      for (const id of ["ownership", "privileges", "prevrandao"] as const) {
        const [got, want] = [find(proxied, id).status, find(bare, id).status];
        expect([id, got, REASSURANCE[got] <= REASSURANCE[want]]).toEqual([id, got, true]);
        expect([id, got]).not.toEqual([id, "pass"]);
      }
    }
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

  // --- Wave H, R2: "nothing found" is only evidence once the dispatcher was demonstrably read ---

  it("claims nothing about code whose dispatcher it never recognised", async () => {
    // A single STOP: no selectors, so every "nothing of the sort in here" finding would be about a
    // scan that read nothing. Vyper's dense dispatcher, Huff, a fallback-only contract and via-IR
    // jump tables all reach this engine the same way.
    const r = await run({ code: { [TOKEN]: "0x00" } });
    for (const id of ["ownership", "privileges", "prevrandao"] as const) {
      expect([id, find(r, id).status]).toEqual([id, "unknown"]);
      expect([id, find(r, id).title]).toEqual([id, "Couldn't read this contract's functions"]);
    }
  });

  it("still reports a privileged selector it did find, even with no transfer function in sight", async () => {
    // PUSH4 mint(address,uint256) · STOP. Nothing here proves the dispatcher was read in full, so
    // no absence can be claimed — but what WAS seen is evidence, and it still fails.
    const r = await run({ code: { [TOKEN]: "0x6340c10f1900" }, reads: { [`${TOKEN}.owner()`]: OWNER } });
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
    expect(find(r, "ownership")).toMatchObject({ status: "warn", title: "Owned by a wallet" });
  });

  it("accepts a verified ABI as proof the functions were read when the bytecode scan can't see them", async () => {
    // The way out for a contract whose dispatcher this engine can't parse: the explorer publishes
    // its functions, so "there is no mint here" rests on something after all.
    const ex = explorer({
      contract: async () => ({
        verified: true, name: "Vyper", abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable" }],
        proxyType: null, implementations: [],
      }),
    });
    const r = await run({ code: { [TOKEN]: "0x00" } }, ex);
    expect(find(r, "privileges")).toMatchObject({ status: "pass", title: "No privileged functions found" });
    expect(find(r, "ownership")).toMatchObject({ status: "pass", title: "No owner function" });
  });

  // --- Wave H: the resolved logic has to answer for itself ---
  //
  // Whatever address the engine ends up calling "the logic", it is only the logic if it isn't a
  // proxy in its own right, and the scan can only vouch for code it can actually see.

  it("never scores a resolved implementation that is a proxy itself, dispatcher or no dispatcher", async () => {
    // IMPL is a TransparentUpgradeableProxy-shaped contract: one function of its own (admin()) in
    // front of a DELEGATECALL, so it escapes any "no dispatcher at all" net.
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: "0x63f851a440f400", [GRAND]: MINTABLE },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL), [`${IMPL}:${IMPL_SLOT}`]: slotWith(GRAND) },
    });
    for (const id of ["ownership", "privileges", "prevrandao"] as const) {
      expect([id, find(r, id).status]).toEqual([id, "unknown"]);
    }
    expect(find(r, "privileges").detail).toMatch(/further proxy/);
  });

  it("says unknown when a resolved implementation's own proxy slots can't be read", async () => {
    // An unread slot is not an unset one: without it, "this implementation isn't itself a proxy"
    // is an assumption, and everything scored from its code rests on that assumption.
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: PLAIN },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) },
      storageErrors: { [`${IMPL}:${IMPL_SLOT}`]: new Error("ETIMEDOUT") },
    });
    expect(find(r, "privileges")).toMatchObject({ status: "unknown", title: "Couldn't read the contract's logic" });
    expect(find(r, "prevrandao").status).toBe("unknown");
  });

  it("prefers unknown over R1's warn when the logic it would judge can run code it can't see", async () => {
    // A UUPS implementation contains a DELEGATECALL and sits behind an upgradeable proxy, so both
    // rules apply. "This might change later" is the weaker statement; "I can't see what it runs"
    // is the true one.
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: "0x63a9059cbbf400" }, // PUSH4 transfer · DELEGATECALL · STOP
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL), [`${TOKEN}:${ADMIN_SLOT}`]: slotWith(OWNER) },
    });
    for (const id of ["ownership", "privileges", "prevrandao"] as const) {
      expect([id, find(r, id).status]).toEqual([id, "unknown"]);
      expect([id, find(r, id).title]).toEqual([id, "Runs code this check can't see"]);
    }
  });

  it("keeps what it did see in code that delegates: the mint still fails, nothing else passes", async () => {
    // PUSH4 transfer · PUSH4 mint(address,uint256) · DELEGATECALL · STOP. The dispatcher is this
    // contract's own and what it holds is real evidence; only the would-be passes are blocked.
    const r = await run({ code: { [TOKEN]: "0x63a9059cbb6340c10f19f400" }, reads: { [`${TOKEN}.owner()`]: OWNER } });
    expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
    expect(find(r, "ownership")).toMatchObject({ status: "warn", title: "Owned by a wallet" });
    expect(find(r, "prevrandao")).toMatchObject({ status: "unknown", title: "Runs code this check can't see" });
    expect(find(r, "proxy")).toMatchObject({ status: "unknown", title: "This contract forwards calls to code that couldn't be identified" });
  });

  // --- Wave H: with both EIP-1967 slots set, which one runs isn't storage's to say ---

  it("scores nothing when both the implementation and the beacon slot are set", async () => {
    // A BeaconProxy with a stale or decoy implementation slot runs the BEACON's implementation;
    // a transparent proxy with a leftover beacon slot runs the implementation slot. Only the
    // proxy's own bytecode decides, so picking one and scoring it is a guess.
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: PLAIN, [BEACON]: PLAIN, [GRAND]: MINTABLE },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL), [`${TOKEN}:${BEACON_SLOT}`]: slotWith(BEACON) },
      reads: { [`${BEACON}.implementation()`]: GRAND },
    });
    expect(find(r, "proxy").status).toBe("fail"); // still upgradeable, whichever one runs
    for (const id of ["ownership", "privileges", "prevrandao"] as const) {
      expect([id, find(r, id).status]).toEqual([id, "unknown"]);
    }
    expect(find(r, "privileges")).toMatchObject({ title: "Couldn't read the contract's logic" });
    expect(find(r, "privileges").detail).toMatch(/both/i);
  });

  // --- Wave H, R1: mutable logic can't earn a pass about logic ---
  //
  // "No privileged functions", "ownership is renounced", "no owner function" and "doesn't use
  // PREVRANDAO" are all statements about code that whoever controls the proxy can replace. They
  // stay true of the logic running now, which is why they become `warn` (naming who can replace
  // it), never `pass`.

  it("never passes ownership or privileges for renounced logic behind an upgradeable proxy", async () => {
    // The realistic rug shape: the implementation's owner() is renounced, the proxy admin is a
    // live EOA. "Privileged functions can't be called" is affirmatively false here.
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: MINTABLE },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL), [`${TOKEN}:${ADMIN_SLOT}`]: slotWith(OWNER) },
      reads: { [`${TOKEN}.owner()`]: ZERO },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Upgradeable — admin 0x3333…3333" });
    for (const id of ["ownership", "privileges", "prevrandao"] as const) {
      expect([id, find(r, id).status]).toEqual([id, "warn"]);
      expect([id, find(r, id).detail]).toEqual([id, expect.stringContaining("0x3333…3333")]);
      expect([id, find(r, id).evidenceUrl]).toEqual([id, `https://explorer.test/address/${TOKEN}?tab=contract`]);
    }
  });

  it("says whoever controls upgrades, without naming one, when the admin slot is empty (UUPS or a beacon)", async () => {
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: MINTABLE },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) }, // no admin slot: UUPS keeps the right in the logic
      reads: { [`${TOKEN}.owner()`]: ZERO },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Upgradeable proxy" });
    expect(find(r, "privileges")).toMatchObject({ status: "warn" });
    expect(find(r, "privileges").detail).toMatch(/whoever controls upgrades/);
  });

  it("treats an admin slot that won't read like an empty one, without disturbing any other check", async () => {
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: MINTABLE },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) },
      storageErrors: { [`${TOKEN}:${ADMIN_SLOT}`]: new Error("ETIMEDOUT") },
      reads: { [`${TOKEN}.owner()`]: ZERO },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Upgradeable proxy" });
    expect(find(r, "privileges")).toMatchObject({ status: "warn" });
    expect(find(r, "privileges").detail).toMatch(/whoever controls upgrades/);
  });

  it("gives a clone of an upgradeable proxy no logic pass either, however clean the logic behind it is", async () => {
    const r = await run({
      code: { [TOKEN]: cloneOf(IMPL), [IMPL]: PLAIN, [GRAND]: PLAIN },
      storage: { [`${IMPL}:${IMPL_SLOT}`]: slotWith(GRAND), [`${IMPL}:${ADMIN_SLOT}`]: slotWith(OWNER) },
    });
    expect(find(r, "proxy")).toMatchObject({ status: "fail", title: "Clone of an upgradeable proxy" });
    for (const id of ["ownership", "privileges", "prevrandao"] as const) {
      expect([id, find(r, id).status]).toEqual([id, "warn"]);
    }
    // The admin read happens on the address whose slots make this upgradeable — the clone's target.
    expect(find(r, "privileges").detail).toMatch(/0x3333…3333/);
    expect(find(r, "privileges").evidenceUrl).toBe(`https://explorer.test/address/${IMPL}?tab=contract`);
  });

  // --- Wave F item 2: a failed storage read is never "the target is not a proxy" ---

  it("won't call a clone's logic unreplaceable when that logic runs code from somewhere it can't see", async () => {
    // The clone itself can't be re-pointed, but "its logic can't be replaced" is a claim about the
    // code that ends up running — and this implementation DELEGATECALLs to an address that isn't
    // an EIP-1967 slot or a clone target, so whoever controls that address controls the behaviour.
    // The top-level path has refused this since wave D; the clone path was still passing it.
    const r = await run({ code: { [TOKEN]: cloneOf(IMPL), [IMPL]: "0x63a9059cbbf400" } });
    expect(find(r, "proxy")).toMatchObject({ status: "unknown" });
    expect(find(r, "proxy").detail).toMatch(/delegate/i);
  });

  it("says unknown, not 'not upgradeable', when a clone target's EIP-1967 slots can't be read", async () => {
    const r = await run({ code: { [TOKEN]: cloneOf(IMPL), [IMPL]: PLAIN }, storageError: new Error("ETIMEDOUT") });
    expect(find(r, "proxy")).toMatchObject({ status: "unknown", title: "Couldn't check whether this clone is upgradeable" });
  });

  // Not a wave F fix, despite where it sits: a top-level storage failure already propagated out of
  // checkProxy into the orchestrator's guard before wave F, and this test passes with wave F's
  // change reverted. It is kept as the guard for that pre-existing behaviour — the one thing that
  // must never happen is a storage read failing and the report saying "Not a proxy" anyway.
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
      topHolders: page(threeHolders),
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

  // --- Wave H: "All N wallets" is a claim about the whole list; a floor isn't a concentration ---

  it("accepts the explorer's own last-page marker as confirmation that a short list is everyone", async () => {
    // No holders_count at all, but `next_page_params: null` said this page is the whole list.
    const ex = explorer({
      topHolders: page(threeHolders, true),
      token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: null }),
    });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders")).toMatchObject({ status: "pass", title: "All 3 wallets hold 24%" });
  });

  it("never says 'All N wallets' about one page of a longer list, and won't pass on a floor", async () => {
    // Ten rows — enough to clear the "fewer than ten" gate — but three of them are the burn
    // addresses and the token contract itself, so seven wallets are left to add up out of a list
    // the explorer says has thousands. Counting those seven as "all" of them was the defect.
    const wallets = Array.from({ length: 7 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, "0")}`, isContract: false, name: null, value: 20n,
    }));
    const ex = explorer({
      topHolders: page([
        { address: DEAD, isContract: false, name: null, value: 400n },
        { address: ZERO, isContract: false, name: null, value: 300n },
        { address: TOKEN, isContract: true, name: null, value: 100n },
        ...wallets,
      ]),
      token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: 5000 }),
    });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders").status).toBe("unknown"); // 14% is a floor, not the concentration
    expect(find(r, "holders").title).not.toMatch(/^All /);
  });

  it("still fails on a floor that already crosses the threshold on its own", async () => {
    // Same shape, but the seven wallets in hand already hold 56% between them: more holders can
    // only add to that, so "over half the supply sits in a few wallets" is evidence either way.
    const wallets = Array.from({ length: 7 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, "0")}`, isContract: false, name: null, value: 80n,
    }));
    const ex = explorer({
      topHolders: page([
        { address: DEAD, isContract: false, name: null, value: 400n },
        { address: ZERO, isContract: false, name: null, value: 30n },
        { address: TOKEN, isContract: true, name: null, value: 10n },
        ...wallets,
      ]),
      token: async () => ({ name: "T", symbol: "T", decimals: 18, totalSupply: "1000", holdersCount: 5000 }),
    });
    const r = await run({ code: { [TOKEN]: PLAIN }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } }, ex);
    expect(find(r, "holders")).toMatchObject({ status: "fail", title: "The top 7 wallets hold at least 56%" });
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

  // --- Wave H: "verified" has to cover the code that actually runs ---

  const proxyOver = (implVerified: boolean | null) =>
    explorer({
      contract: async (a) =>
        a.toLowerCase() === IMPL.toLowerCase()
          ? { verified: implVerified, name: "Logic", abi: null, proxyType: null, implementations: [] }
          : { verified: true, name: "Proxy", abi: null, proxyType: "eip1967", implementations: [] },
    });
  const proxied = { code: { [TOKEN]: PLAIN, [IMPL]: PLAIN }, storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) } };

  it("fails verification when a verified proxy runs unverified code", async () => {
    const r = await run(proxied, proxyOver(false));
    expect(find(r, "verified")).toMatchObject({ status: "fail", title: "The code this proxy runs isn't verified" });
    expect(find(r, "verified").evidenceUrl).toBe(`https://explorer.test/address/${IMPL}?tab=contract`);
  });

  it("says unknown when the implementation's verification status can't be established", async () => {
    const r = await run(proxied, proxyOver(null));
    expect(find(r, "verified")).toMatchObject({ status: "unknown", title: "Couldn't check source verification" });
  });

  it("passes verification when both the proxy and the implementation are verified", async () => {
    const r = await run(proxied, proxyOver(true));
    expect(find(r, "verified")).toMatchObject({ status: "pass", title: "Source code is verified" });
  });

  // Found by wave H's own pass-by-pass audit: the same defect as D7, on the paths D7 didn't reach.

  it("won't call the source verified when which code the proxy runs can't even be told", async () => {
    // Both EIP-1967 slots set: the explorer says this address's source is published, but what it
    // publishes is the forwarding code, and which of the two implementations runs is unknown.
    const r = await run({
      code: { [TOKEN]: PLAIN, [IMPL]: PLAIN, [BEACON]: PLAIN },
      storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL), [`${TOKEN}:${BEACON_SLOT}`]: slotWith(BEACON) },
    });
    expect(find(r, "verified")).toMatchObject({ status: "unknown", title: "Couldn't check source verification" });
  });

  it("checks the implementation's record for an EIP-1167 clone too, not just the trampoline's", async () => {
    const ex = explorer({
      contract: async (a) =>
        a.toLowerCase() === IMPL.toLowerCase()
          ? { verified: false, name: null, abi: null, proxyType: null, implementations: [] }
          : { verified: true, name: "Clone", abi: null, proxyType: null, implementations: [] },
    });
    const r = await run({ code: { [TOKEN]: cloneOf(IMPL), [IMPL]: PLAIN } }, ex);
    expect(find(r, "verified")).toMatchObject({ status: "fail", title: "The code this proxy runs isn't verified" });
  });

  // I1 (wave I): the report must never name an address as "the implementation it runs" when the
  // engine itself refused to score that address as the logic. Each of these three leaves
  // `privileges` saying the code that runs couldn't be identified, so `verified` cannot
  // simultaneously say it has checked it.

  /** Everything verified except `unverified`, which the explorer positively reports as not. */
  const allVerifiedExcept = (unverified: string) =>
    explorer({
      contract: async (a) => ({
        verified: a.toLowerCase() !== unverified.toLowerCase(),
        name: null, abi: null, proxyType: null, implementations: [],
      }),
    });

  it("won't vouch for an implementation that is itself a proxy over unverified logic", async () => {
    const r = await run(
      {
        code: { [TOKEN]: PLAIN, [IMPL]: "0x63f851a440f400", [GRAND]: MINTABLE },
        storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL), [`${IMPL}:${IMPL_SLOT}`]: slotWith(GRAND) },
      },
      allVerifiedExcept(GRAND),
    );
    expect(find(r, "privileges").status).toBe("unknown"); // the logic was never identified...
    expect(find(r, "verified").status).not.toBe("pass"); // ...so nothing can be vouched for either
    expect(find(r, "verified").detail).not.toContain(IMPL);
  });

  it("won't vouch for a clone target that is itself a clone over unverified logic", async () => {
    const r = await run(
      { code: { [TOKEN]: cloneOf(IMPL), [IMPL]: cloneOf(GRAND), [GRAND]: MINTABLE } },
      allVerifiedExcept(GRAND),
    );
    expect(find(r, "privileges").status).toBe("unknown");
    expect(find(r, "verified").status).not.toBe("pass");
  });

  it("won't vouch for an implementation slot that points at empty code", async () => {
    const r = await run({ code: { [TOKEN]: PLAIN }, storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL) } });
    expect(find(r, "privileges").status).toBe("unknown");
    expect(find(r, "verified").status).not.toBe("pass");
  });

  it("still fails verification when the explorer positively says the source isn't verified", async () => {
    const ex = explorer({ contract: async () => ({ verified: false, name: null, abi: null, proxyType: null, implementations: [] }) });
    const r = await run({ code: { [TOKEN]: PLAIN } }, ex);
    expect(find(r, "verified")).toMatchObject({ status: "fail", title: "Source code isn't verified" });
  });

  // N9 (wave G): wave F's fix above was correct in principle but wrong about the explorer — a real
  // unverified contract's /smart-contracts/<addr> answers 200 with no `is_verified` field at all
  // (measured on the Arc testnet explorer, 2026-09-20), which silently turned this into "unknown"
  // instead of "fail". This drives `inspect()` through the REAL blockscoutSource end to end (not a
  // stubbed ExplorerSource) with that exact response shape, so the fix in explorer.ts's fallback to
  // /addresses/<addr> is proven all the way through to the finding a user actually sees.
  it("reports fail — not unknown — for the real testnet shape of an unverified ERC-20: no is_verified field on /smart-contracts, resolved via /addresses", async () => {
    const apiUrl = "https://explorer.test/api/v2";
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const path = String(input).replace(apiUrl, "");
      const bodies: Record<string, unknown> = {
        [`/smart-contracts/${TOKEN}`]: {
          conflicting_implementations: [],
          creation_bytecode: "0x6080604052",
          creation_status: "success",
          deployed_bytecode: "0x6080604052",
          implementations: [],
          proxy_type: null,
        },
        [`/addresses/${TOKEN}`]: { is_contract: true, is_verified: false },
      };
      if (!(path in bodies)) return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
      return new Response(JSON.stringify(bodies[path]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const r = await run({ code: { [TOKEN]: PLAIN } }, blockscoutSource(apiUrl, fakeFetch));
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

  // --- Wave H safety rail: this repo's own deployed token templates, as ground truth ---
  //
  // Every other fixture in this file is a hand-written toy (`PLAIN` is a single PUSH4). These two
  // are the REAL compiled bytecode of the templates the Mint app deploys, so "a token minted here
  // reads as clean in Inspector" is asserted against the thing that actually gets deployed — and
  // they are the ground truth for the dispatcher-visibility rule: a scan that can't see the
  // dispatcher of THESE can't claim to have seen anyone's.

  describe("the repo's own token templates", () => {
    it("sees the ERC-20 dispatcher in both templates' real bytecode", () => {
      const standard = extractSelectors(STANDARD_TOKEN_DEPLOYED);
      const mintable = extractSelectors(MINTABLE_TOKEN_DEPLOYED);
      const TRANSFER = "0xa9059cbb"; // transfer(address,uint256)
      const MINT = "0x40c10f19"; // mint(address,uint256)
      expect([standard.has(TRANSFER), mintable.has(TRANSFER)]).toEqual([true, true]);
      expect([standard.has(MINT), mintable.has(MINT)]).toEqual([false, true]);
    });

    it("reads a real StandardToken as clean on ownership, privileges, proxy and prevrandao", async () => {
      const r = await run({ code: { [TOKEN]: STANDARD_TOKEN_DEPLOYED }, reads: { [`${TOKEN}.totalSupply()`]: 1000n } });
      for (const id of ["ownership", "privileges", "proxy", "prevrandao"] as const) {
        expect([id, find(r, id).status]).toEqual([id, "pass"]);
      }
      expect(find(r, "ownership").title).toBe("No owner function");
      expect(find(r, "privileges").title).toBe("No privileged functions found");
    });

    it("reads a real MintableToken as owned, with the mint function found", async () => {
      const r = await run({ code: { [TOKEN]: MINTABLE_TOKEN_DEPLOYED }, reads: { [`${TOKEN}.owner()`]: OWNER } });
      expect(find(r, "ownership")).toMatchObject({ status: "warn", title: "Owned by a wallet" });
      expect(find(r, "privileges")).toMatchObject({ status: "fail", title: "Owner can mint new supply" });
      expect(find(r, "proxy").status).toBe("pass");
    });

    it("reads an EIP-1167 clone of a real StandardToken as a non-upgradeable minimal proxy with clean logic", async () => {
      const r = await run({ code: { [TOKEN]: cloneOf(IMPL), [IMPL]: STANDARD_TOKEN_DEPLOYED } });
      expect(find(r, "proxy")).toMatchObject({ status: "pass", title: "Minimal proxy — not upgradeable" });
      for (const id of ["ownership", "privileges", "prevrandao"] as const) {
        expect([id, find(r, id).status]).toEqual([id, "pass"]);
      }
    });
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
