import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UserFacingError } from "../contract-error";
import { assertWalletOnChain, withChain } from "../paid-write";

describe("withChain", () => {
  it("returns the request with chainId set", () => {
    expect(withChain({ address: "0xabc" }, 5042)).toEqual({ address: "0xabc", chainId: 5042 });
  });

  it("preserves every other field on the request untouched", () => {
    const request = { functionName: "createToken", args: [1, 2, 3], value: 15n };
    expect(withChain(request, 5042)).toEqual({ ...request, chainId: 5042 });
  });

  it("overwrites a chainId already on the request rather than merging two", () => {
    expect(withChain({ chainId: 1 }, 5042)).toEqual({ chainId: 5042 });
  });

  // The whole point of this helper (see its doc comment): wagmi's writeContract silently sends on the
  // wallet's CURRENT chain — skipping viem's assertCurrentChain entirely — when chainId is undefined.
  // A caller that forgets to resolve a real chain id must fail loudly here, not send an unguarded
  // transaction.
  it("throws when chainId is undefined, instead of silently omitting it", () => {
    expect(() => withChain({ address: "0xabc" }, undefined)).toThrow(/chainId/i);
  });
});

describe("assertWalletOnChain", () => {
  it("does not throw when the wallet's chain matches the expected chain", () => {
    expect(() => assertWalletOnChain(5042, 5042)).not.toThrow();
  });

  it("throws a UserFacingError when the wallet is on a different chain", () => {
    expect(() => assertWalletOnChain(1, 5042)).toThrow(UserFacingError);
    expect(() => assertWalletOnChain(1, 5042)).toThrow("Your wallet is on a different network. Switch to Arc and try again.");
  });

  it("throws when the wallet's chain id is unknown (not connected / still resolving)", () => {
    expect(() => assertWalletOnChain(undefined, 5042)).toThrow(UserFacingError);
  });
});

/**
 * A plain source-text scan, not a component/integration test: a render test (jsdom, opted into per
 * file with `// @vitest-environment jsdom`) covers one window's Submit, while this scan covers every
 * file that could make a paid write. It guards against the exact regression wave C introduced: it
 * fails loudly the moment any future edit adds an unguarded paid write, instead of silently shipping it.
 *
 * It doesn't try to guess which files might write. It reads EVERY source file under apps/web/src and
 * packages/<name>/src (tests and the paid-write helper itself aside) and checks two things in each:
 *
 * - every call of a paid-write action by name (wagmi's and viem's writeContract, sendTransaction,
 *   sendCalls and deployContract with their Async/Sync forms, and Revoke's `deps.writeContractAsync`)
 *   has `withChain(...)` as its first argument, whatever the receiver: a viem wallet client, a wagmi
 *   action, or a function passed in;
 * - every `mutate`/`mutateAsync` — the way wagmi 3's hooks are called, from useWriteContract to a
 *   custom hook wrapping it — is either a call with `withChain(...)` as its first argument, or a
 *   reviewed entry in ALLOWLIST below (pinned to its file, its receiver, and how many times it may
 *   appear). That covers a bare reference too (`const go = w.mutateAsync`, or one passed on), which
 *   could be called anywhere.
 *
 * Wave G, N3 still applies: a destructuring rename (`const { mutateAsync: doIt } = useWriteContract()`)
 * would hide every later call from a scan by name, so any such alias fails outright.
 */
describe("every paid write goes through withChain (every source file, every write action, every mutate)", () => {
  const webSrc = path.resolve(import.meta.dirname, "..", "..");
  const repo = path.resolve(webSrc, "..", "..", "..");
  const HELPER = path.resolve(import.meta.dirname, "..", "paid-write.ts");

  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listSourceFiles(full));
      else if (entry.isFile() && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name) && full !== HELPER) {
        out.push(full);
      }
    }
    return out;
  }

  const packageSrcs = readdirSync(path.join(repo, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(repo, "packages", e.name, "src")))
    .map((e) => path.join(repo, "packages", e.name, "src"));
  const files = [webSrc, ...packageSrcs].flatMap(listSourceFiles);
  const rel = (file: string) => path.relative(repo, file).split(path.sep).join("/");

  /** Strips both block comments and line comments so a doc comment that merely MENTIONS one of
   * these function names can't be misread as a real, unwrapped call site. Good enough for this
   * codebase's actual files — none of the real call sites share a line with a comment or a string
   * containing two consecutive slashes — without needing a full tokenizer. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const ACTION_NAMES = [
    "writeContractAsync",
    "writeContractSync",
    "writeContract",
    "sendTransactionSync",
    "sendTransaction",
    "sendCallsSync",
    "sendCalls",
    "deployContract",
  ];
  const MUTATION_NAMES = ["mutateAsync", "mutate"];
  const FUNCTION_NAMES = [...ACTION_NAMES, ...MUTATION_NAMES];
  // What follows a name when it is called: optional generics, then `(` or `?.(`.
  const CALL_TAIL = String.raw`\s*(?:<[^>]*>)?\s*\??\.?\(`;
  const ACTION_CALL = new RegExp(String.raw`\b(?:${ACTION_NAMES.join("|")})${CALL_TAIL}`, "g");
  const MUTATION = new RegExp(String.raw`(?:([A-Za-z_$][\w$]*)\s*\??\.\s*)?\b(${MUTATION_NAMES.join("|")})\b`, "g");
  const CALLED = new RegExp(`^${CALL_TAIL}`);

  type Allowed = { file: string; receiver: string; member: "mutate" | "mutateAsync"; kind: "call" | "reference"; count: number; reason: string };

  /**
   * The mutate/mutateAsync uses that are not paid writes, or that hand one on to a call this scan
   * checks elsewhere. Each is pinned to a file, a receiver (`(bare)` for a destructured name) and the
   * exact number of times it appears there, so a second use, or one in another file, fails.
   */
  const ALLOWLIST: Allowed[] = [
    { file: "apps/web/src/apps/wallet/Window.tsx", receiver: "connect", member: "mutate", kind: "call", count: 1, reason: "useConnect: connects a wallet, sends nothing" },
    { file: "apps/web/src/apps/wallet/Window.tsx", receiver: "disconnect", member: "mutate", kind: "call", count: 1, reason: "useDisconnect: ends the connection, sends nothing" },
    { file: "apps/web/src/lib/network.ts", receiver: "switchChain", member: "mutate", kind: "call", count: 1, reason: "useSwitchChain: asks the wallet to change network, sends nothing" },
    {
      file: "apps/web/src/apps/revoke/Window.tsx",
      receiver: "writeContract",
      member: "mutateAsync",
      kind: "reference",
      count: 1,
      reason: "handed to revoke/flow.ts as deps.writeContractAsync, whose one call this scan checks for withChain",
    },
    { file: "apps/web/src/apps/drop/useDrop.ts", receiver: "(bare)", member: "mutateAsync", kind: "reference", count: 1, reason: "send's useCallback dependency list" },
  ];

  /** Where `index` falls inside a `const|let|var { ... } =` pattern: a name bound there is checked where it's used. */
  function destructuringRanges(source: string): Array<[number, number]> {
    return [...source.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)].map((m) => [m.index, m.index + m[0].length]);
  }

  type Site = { name: string; receiver: string; kind: "call" | "reference"; wrapped: boolean; text: string };

  /** Every paid-write action call and every mutate/mutateAsync use in `source` (comments stripped). */
  function writeSites(raw: string): Site[] {
    const source = stripComments(raw);
    const sites: Site[] = [];
    const firstArgWrapped = (from: number) => source.slice(from).trimStart().startsWith("withChain(");
    const snippet = (from: number) => source.slice(from, from + 60).replace(/\s+/g, " ");
    for (const m of source.matchAll(ACTION_CALL)) {
      const end = m.index + m[0].length;
      sites.push({ name: m[0].replace(/\W.*$/s, ""), receiver: "", kind: "call", wrapped: firstArgWrapped(end), text: snippet(m.index) });
    }
    const bindings = destructuringRanges(source);
    for (const m of source.matchAll(MUTATION)) {
      const [whole, receiver, name] = m;
      const nameEnd = m.index + whole.length;
      const call = CALLED.exec(source.slice(nameEnd));
      if (call) {
        const end = nameEnd + call[0].length;
        sites.push({ name: name!, receiver: receiver ?? "(bare)", kind: "call", wrapped: firstArgWrapped(end), text: snippet(m.index) });
        continue;
      }
      // A plain name bound by destructuring: its calls are checked where they happen, and an alias fails below.
      if (!receiver && bindings.some(([from, to]) => m.index >= from && m.index < to)) continue;
      sites.push({ name: name!, receiver: receiver ?? "(bare)", kind: "reference", wrapped: false, text: snippet(m.index) });
    }
    return sites;
  }

  /** What is wrong in one file: unwrapped calls, and mutate uses the allowlist doesn't cover exactly. */
  function offenders(file: string, source: string, allowlist: Allowed[]): string[] {
    const found: string[] = [];
    const unlisted = new Map<string, Site[]>();
    for (const site of writeSites(source)) {
      if (site.wrapped) continue;
      if (!MUTATION_NAMES.includes(site.name)) {
        found.push(`${file}: ${site.text}… is not wrapped in withChain`);
        continue;
      }
      const key = `${site.receiver}.${site.name} ${site.kind}`;
      unlisted.set(key, [...(unlisted.get(key) ?? []), site]);
    }
    for (const [key, sites] of unlisted) {
      const entry = allowlist.find((a) => a.file === file && `${a.receiver}.${a.member} ${a.kind}` === key);
      if (!entry) for (const s of sites) found.push(`${file}: ${s.text}… (${key}) is neither wrapped in withChain nor allowlisted`);
      else if (sites.length !== entry.count) found.push(`${file}: ${key} appears ${sites.length} times, allowlisted ${entry.count}`);
    }
    for (const entry of allowlist.filter((a) => a.file === file)) {
      if (!unlisted.has(`${entry.receiver}.${entry.member} ${entry.kind}`)) found.push(`${file}: allowlist entry ${entry.receiver}.${entry.member} ${entry.kind} matches nothing; remove it`);
    }
    return found;
  }

  /**
   * Renames that would hide a paid write from the scan by name — and ONLY those. A bare
   * `name: something` matches far more than a rename: `({ writeContractAsync: mockWrite })` in a
   * test's wagmi mock, and `writeContract: (args) => Promise<void>` in an interface, are both
   * perfectly ordinary and neither puts a call anywhere. What actually defeats the scan is a
   * BINDING — `const { writeContractAsync: doIt } = useWriteContract()` — so the pattern has to be
   * matched inside a destructuring pattern on the left of an `=`, not anywhere a colon appears.
   */
  function aliasesIn(source: string): string[] {
    const found: string[] = [];
    for (const [, bindings] of source.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)) {
      for (const name of FUNCTION_NAMES) {
        const alias = new RegExp(`\\b${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(bindings ?? "");
        if (alias && alias[1] !== name) found.push(`${name}: ${alias[1]}`);
      }
    }
    return found;
  }

  describe("the scanner itself", () => {
    const check = (source: string, allowlist: Allowed[] = []) => offenders("x.ts", source, allowlist);

    it("catches a viem-only file writing through sendCalls, deployContract and writeContractSync", () => {
      const source = [
        'import { createWalletClient, custom } from "viem";',
        "const wc = createWalletClient({ transport: custom(window.ethereum) });",
        "await wc.sendCalls({ calls });",
        "await wc.deployContract({ abi, bytecode });",
        "await wc.writeContractSync<typeof abi>(request);",
        "await wc.sendTransaction?.(request);",
      ].join("\n");
      expect(check(source)).toHaveLength(4);
      const wrapped = [
        "await wc.sendCalls(withChain({ calls }, 1));",
        "await wc.deployContract(withChain({ abi, bytecode }, 1));",
        "await wc.writeContractSync<typeof abi>(withChain(request, 1));",
        "await wc.sendTransaction?.(withChain(request, 1));",
      ].join("\n");
      expect(check(wrapped)).toEqual([]);
    });

    it("catches a write through a custom hook that returns useWriteContract()", () => {
      const source = [
        "function useMyPay() { return useWriteContract(); }",
        "const w = useMyPay();",
        "await w.mutateAsync(request);",
      ].join("\n");
      expect(check(source)).toHaveLength(1);
      expect(check(source.replace("mutateAsync(request)", "mutateAsync(withChain(request, 1))"))).toEqual([]);
    });

    it("catches mutateAsync handed on by reference, and a destructured one called or returned", () => {
      expect(check("const w = useMyPay();\nconst go = w.mutateAsync;\nawait go(request);")).toHaveLength(1);
      expect(check("const { mutateAsync } = useWriteContractSync();\nawait mutateAsync(request);")).toHaveLength(1);
      expect(check("const { mutateAsync } = useWriteContract();\nreturn { mutateAsync };")).toHaveLength(1);
      expect(check("const { mutateAsync } = useWriteContract();\nawait mutateAsync(withChain(request, 1));")).toEqual([]);
    });

    it("lets an allowlisted connect.mutate through, pinned to its file and count", () => {
      const entry: Allowed = { file: "x.ts", receiver: "connect", member: "mutate", kind: "call", count: 1, reason: "test" };
      const source = "const connect = useConnect();\nconnect.mutate({ connector });";
      expect(check(source, [entry])).toEqual([]);
      expect(check(`${source}\nconnect.mutate({ connector: other });`, [entry])).toHaveLength(1);
      expect(offenders("y.ts", source, [entry])).toHaveLength(1);
      expect(check("const x = 1;", [entry])).toHaveLength(1);
    });

    it("fails a .mutate( call that isn't allowlisted, generics and optional calls included", () => {
      expect(check("switcher.mutate({ chainId: 1 });")).toHaveLength(1);
      expect(check("w.mutateAsync<Hex>(request);")).toHaveLength(1);
      expect(check("w?.mutate?.(request);")).toHaveLength(1);
    });

    it("recognises a destructuring rename, and only that — not a mock's object literal or a type member", () => {
      expect(aliasesIn("const { writeContractAsync: doIt } = useWriteContract();")).toEqual(["writeContractAsync: doIt"]);
      expect(aliasesIn("const { mutateAsync: go } = useWriteContract();")).toEqual(["mutateAsync: go"]);
      expect(aliasesIn("const { writeContractAsync } = useWriteContract();")).toEqual([]);
      expect(aliasesIn("vi.mock('wagmi', () => ({ useWriteContract: () => ({ writeContractAsync: mockWrite }) }));")).toEqual([]);
      expect(aliasesIn("interface FakeWagmi { writeContract: (args: unknown) => Promise<void> }")).toEqual([]);
    });
  });

  it("reads the whole tree, the known paid-write files included", () => {
    const names = files.map(rel);
    for (const known of ["apps/web/src/apps/mint/Window.tsx", "apps/web/src/apps/drop/useDrop.ts", "apps/web/src/apps/revoke/flow.ts"]) {
      expect(names).toContain(known);
    }
    expect(names.some((f) => f.startsWith("packages/"))).toBe(true);
    expect(names.some((f) => f.includes("__tests__") || /\.test\./.test(f))).toBe(false);
  });

  it("finds no destructuring alias of a paid-write function or mutate — that would let a call bypass this whole scan", () => {
    const found = files.flatMap((f) => aliasesIn(stripComments(readFileSync(f, "utf8"))).map((a) => `${rel(f)}: \`${a}\``));
    expect(found, `found a destructuring rename that would hide a paid write from this scan:\n${found.join("\n")}`).toEqual([]);
  });

  it("every paid write in every source file is wrapped in withChain(...), and every other mutate is allowlisted", () => {
    const found = files.flatMap((f) => offenders(rel(f), readFileSync(f, "utf8"), ALLOWLIST));
    for (const entry of ALLOWLIST) expect(files.map(rel), entry.reason).toContain(entry.file);
    expect(found, found.join("\n")).toEqual([]);
    // A vacuous scan (no wrapped writes anywhere) would pass trivially: fail loudly instead, since it
    // means the paid writes this test guards moved or were renamed out from under it.
    const wrapped = files.flatMap((f) => writeSites(readFileSync(f, "utf8")).filter((s) => s.wrapped));
    expect(wrapped.length).toBeGreaterThanOrEqual(5);
  });
});
