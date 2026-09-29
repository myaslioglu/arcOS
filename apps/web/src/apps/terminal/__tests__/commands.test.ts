import { describe, expect, it } from "vitest";
import { explorerUrl } from "@arcos/chain";
import type { AppManifest } from "@arcos/shell/core";
import { COMMAND_NAMES, PLAIN_TRANSFER_GAS, complete, echo, parseCommand, runCommand, sanitize, type TermEnv } from "../commands";

const icon = (() => null) as unknown as AppManifest["icon"];
const app = (id: string, name: string, over: Partial<AppManifest> = {}): AppManifest => ({
  id,
  name,
  blurb: `${name} blurb`,
  icon,
  category: "system",
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
  ...over,
});
const APPS = [
  app("finder", "Finder"),
  app("inspector", "Inspector"),
  app("watchdog", "Watchdog", { comingSoon: true, release: "r1", blurb: "Alerts when a token you hold changes" }),
  app("vault", "Vault", { comingSoon: true, release: "r2", blurb: "Lock liquidity and team tokens" }),
];
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ARC = { id: 5042002, name: "Arc Testnet" };

function setup(over: Partial<TermEnv> = {}) {
  const opened: { appId: string; params?: Record<string, string> }[] = [];
  const themes: string[] = [];
  const reads = { balance: 0, latestBlock: 0 };
  const env: TermEnv = {
    apps: APPS,
    open: (appId, params) => {
      opened.push({ appId, params });
      return true;
    },
    account: { address: WALLET, chainId: ARC.id },
    chain: ARC,
    read: {
      balance: async () => {
        reads.balance += 1;
        return 12_500_000_000_000_000_000n;
      },
      latestBlock: async () => {
        reads.latestBlock += 1;
        return { number: 1_234_567n, timestamp: 1_000n, baseFeePerGas: 20_000_000_000n, txCount: 3 };
      },
    },
    setTheme: (preference) => {
      themes.push(preference);
    },
    history: ["help", "block"],
    now: () => 1_002_000,
    ...over,
  };
  return { env, opened, themes, reads };
}
const texts = async (raw: string, env: TermEnv) => (await runCommand(raw, env)).lines.map((l) => l.text);
const failing = async (): Promise<never> => {
  throw new Error("rpc down");
};

describe("parseCommand", () => {
  it("reads the command name in any case, and keeps the arguments as typed", () => {
    expect(parseCommand("  OPEN   Inspector ")).toEqual({ name: "open", args: ["Inspector"] });
    expect(parseCommand("balance 0xAbC")).toEqual({ name: "balance", args: ["0xAbC"] });
    expect(parseCommand("   ")).toBeNull();
  });
});

describe("help", () => {
  it("lists every command, each with what it does", async () => {
    const lines = await texts("help", setup().env);
    expect(COMMAND_NAMES).toEqual([
      "help",
      "open",
      "inspect",
      "approvals",
      "balance",
      "block",
      "gas",
      "whoami",
      "theme",
      "roadmap",
      "clear",
      "history",
      "about",
    ]);
    expect(lines).toHaveLength(COMMAND_NAMES.length);
    lines.forEach((line, i) => expect(line.startsWith(COMMAND_NAMES[i])).toBe(true));
    expect(lines[8]).toBe("theme light|dark|system  Sets the theme");
  });
});

describe("an unknown command", () => {
  it("names what it didn't know, cut short when long", async () => {
    expect(await texts("frobnicate", setup().env)).toEqual(["Unknown command: frobnicate. Type help."]);
    expect(await texts("x".repeat(40), setup().env)).toEqual([`Unknown command: ${"x".repeat(32)}…. Type help.`]);
    expect((await runCommand("frobnicate", setup().env)).lines[0].kind).toBe("err");
  });
});

describe("open", () => {
  it("lists the app ids, marking the grey ones, when given none", async () => {
    expect(await texts("open", setup().env)).toEqual([
      `${"finder".padEnd(12)}Finder`,
      `${"inspector".padEnd(12)}Inspector`,
      `${"watchdog".padEnd(12)}Watchdog (work in progress)`,
      `${"vault".padEnd(12)}Vault (work in progress)`,
    ]);
  });

  it("opens an app, live or grey, by its id in any case", async () => {
    const s = setup();
    expect(await texts("open Inspector", s.env)).toEqual(["Opened Inspector."]);
    expect(await texts("open vault", s.env)).toEqual(["Opened Vault (work in progress)."]);
    expect(s.opened).toEqual([
      { appId: "inspector", params: undefined },
      { appId: "vault", params: undefined },
    ]);
  });

  it("answers when there is no such app, prototype names included", async () => {
    const s = setup();
    for (const name of ["nope", "constructor", "__proto__", "toString"]) {
      expect(await texts(`open ${name}`, s.env)).toEqual([`No app called ${name}. Type open to list them.`]);
    }
    expect(s.opened).toEqual([]);
  });

  it("strips a bidi override from the name it echoes back", async () => {
    const s = setup();
    expect(await texts("open \u202Efoo", s.env)).toEqual(["No app called foo. Type open to list them."]);
    expect(s.opened).toEqual([]);
  });
});

describe("inspect", () => {
  it("opens Inspector on a checksummed address, and refuses anything else", async () => {
    const s = setup();
    expect(await texts("inspect", s.env)).toEqual(["Usage: inspect <address>"]);
    expect(await texts("inspect 0x12", s.env)).toEqual(["That isn't an address."]);
    expect(await texts(`inspect ${OTHER}`, s.env)).toEqual(["Opened Inspector for 0x2222…2222."]);
    expect(s.opened).toEqual([{ appId: "inspector", params: { token: OTHER } }]);
  });
});

describe("approvals", () => {
  it("opens Revoke for the address given, else for the connected wallet", async () => {
    const s = setup();
    expect(await texts(`approvals ${OTHER}`, s.env)).toEqual(["Opened Revoke for 0x2222…2222."]);
    expect(await texts("approvals", s.env)).toEqual(["Opened Revoke for 0x1111…1111."]);
    expect(s.opened).toEqual([
      { appId: "revoke", params: { owner: OTHER } },
      { appId: "revoke", params: { owner: WALLET } },
    ]);
  });

  it("opens Revoke to ask for an address when no wallet is connected, and refuses a bad one", async () => {
    const s = setup({ account: {} });
    expect(await texts("approvals", s.env)).toEqual(["Opened Revoke."]);
    expect(await texts("approvals nope", s.env)).toEqual(["That isn't an address."]);
    expect(s.opened).toEqual([{ appId: "revoke", params: {} }]);
  });
});

describe("balance", () => {
  it("reads the connected wallet's USDC with one call, linking the address on the explorer", async () => {
    const s = setup();
    const { lines } = await runCommand("balance", s.env);
    expect(lines).toEqual([{ kind: "out", text: "0x1111…1111: 12.5 USDC", href: explorerUrl("address", WALLET) }]);
    expect(s.reads).toEqual({ balance: 1, latestBlock: 0 });
  });

  it("reads another address when given one, and answers when it can't", async () => {
    expect(await texts(`balance ${OTHER}`, setup().env)).toEqual(["0x2222…2222: 12.5 USDC"]);
    expect(await texts("balance", setup({ account: {} }).env)).toEqual(["No wallet connected. Try balance <address>."]);
    expect(await texts("balance 0xnope", setup().env)).toEqual(["That isn't an address."]);
    const broken = setup();
    broken.env.read.balance = failing;
    expect(await texts("balance", broken.env)).toEqual(["Couldn't read the chain. Try again."]);
  });
});

describe("block", () => {
  it("shows the latest block's number, age and transaction count, with one call", async () => {
    const s = setup();
    expect(await texts("block", s.env)).toEqual(["Block 1,234,567 · 2 s ago · 3 transactions"]);
    expect(s.reads.latestBlock).toBe(1);
    const one = setup();
    one.env.read.latestBlock = async () => ({ number: 1n, timestamp: 1_002n, baseFeePerGas: null, txCount: 1 });
    expect(await texts("block", one.env)).toEqual(["Block 1 · 0 s ago · 1 transaction"]);
  });
});

describe("gas", () => {
  it("shows the base fee and what a plain transfer costs at it", async () => {
    expect(PLAIN_TRANSFER_GAS).toBe(21_000n);
    expect(await texts("gas", setup().env)).toEqual([
      "Base fee: 20 gwei",
      "A plain USDC transfer costs 0.00042 USDC at this base fee.",
    ]);
  });

  it("says when the chain reports no base fee, or can't be read", async () => {
    const none = setup();
    none.env.read.latestBlock = async () => ({ number: 1n, timestamp: 1n, baseFeePerGas: null, txCount: 0 });
    expect(await texts("gas", none.env)).toEqual(["This network doesn't report a base fee."]);
    const broken = setup();
    broken.env.read.latestBlock = failing;
    expect(await texts("gas", broken.env)).toEqual(["Couldn't read the chain. Try again."]);
  });
});

describe("whoami", () => {
  it("shows the connected address and its network, or that none is connected", async () => {
    expect(await texts("whoami", setup().env)).toEqual([WALLET, "On Arc Testnet"]);
    expect(await texts("whoami", setup({ account: { address: WALLET, chainId: 1 } }).env)).toEqual([
      WALLET,
      "On another network (chain 1)",
    ]);
    expect(await texts("whoami", setup({ account: {} }).env)).toEqual(["No wallet connected"]);
  });
});

describe("theme", () => {
  it("sets the theme preference, and refuses anything but light, dark or system", async () => {
    const s = setup();
    expect(await texts("theme dark", s.env)).toEqual(["Theme set to dark."]);
    expect(await texts("theme LIGHT", s.env)).toEqual(["Theme set to light."]);
    expect(await texts("theme system", s.env)).toEqual(["Theme set to match your system."]);
    for (const bad of ["theme", "theme sepia", "theme constructor", "theme __proto__"]) {
      expect(await texts(bad, s.env)).toEqual(["Usage: theme light|dark|system"]);
    }
    expect(s.themes).toEqual(["dark", "light", "system"]);
  });
});

describe("roadmap", () => {
  it("lists the grey apps and their stages, soonest first", async () => {
    expect(await texts("roadmap", setup().env)).toEqual([
      `${"Watchdog".padEnd(12)}${"Next up".padEnd(18)}Alerts when a token you hold changes`,
      `${"Vault".padEnd(12)}${"After the audit".padEnd(18)}Lock liquidity and team tokens`,
    ]);
  });

  it("says when nothing is in progress", async () => {
    expect(await texts("roadmap", setup({ apps: [app("finder", "Finder")] }).env)).toEqual(["No apps are in progress."]);
  });
});

describe("clear, history and about", () => {
  it("clears the screen", async () => {
    expect(await runCommand("clear", setup().env)).toEqual({ lines: [], clear: true });
  });

  it("lists this window's commands, numbered", async () => {
    expect(await texts("history", setup().env)).toEqual(["  1  help", "  2  block"]);
  });

  it("sanitizes a typed line the same way its echo would be, so a stored bidi override can't reorder the list", async () => {
    const s = setup({ history: ["help", "open \u202Efoo\u200B"] });
    expect(await texts("history", s.env)).toEqual(["  1  help", "  2  open foo"]);
  });

  it("says what 4rc.OS is", async () => {
    expect(await texts("about", setup().env)).toEqual([
      "4rc.OS is a desktop for Circle's Arc network: inspect a token, mint one and send to many wallets at once.",
      "Type open about for more.",
    ]);
  });
});

describe("complete", () => {
  it("completes command names, app ids after open, and themes after theme", () => {
    const ids = APPS.map((m) => m.id);
    expect(complete("he", ids)).toEqual(["help"]);
    expect(complete("h", ids)).toEqual(["help", "history"]);
    expect(complete("B", ids)).toEqual(["balance", "block"]);
    expect(complete("open in", ids)).toEqual(["open inspector"]);
    expect(complete("open ", ids)).toEqual(["open finder", "open inspector", "open watchdog", "open vault"]);
    expect(complete("theme d", ids)).toEqual(["theme dark"]);
    expect(complete("", ids)).toEqual([]);
    expect(complete("balance 0x", ids)).toEqual([]);
    expect(complete("open finder x", ids)).toEqual([]);
  });
});

describe("sanitize", () => {
  it("strips every Unicode format character (\\p{Cf}), aligned with cleanLabel's set: the zero-width and joiner characters too, not just the bidi controls", () => {
    expect(sanitize("a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf")).toBe("abcdef");
  });

  it("still strips C0/C1 control characters and the bidi overrides", () => {
    expect(sanitize("\u0007bell\u009F")).toBe("bell");
    expect(sanitize("a\u202Eb\u200Ec")).toBe("abc");
  });
});

describe("echo", () => {
  it("keeps typed text short, never splitting a character", () => {
    expect(echo("short")).toBe("short");
    expect(echo("a".repeat(33))).toBe(`${"a".repeat(32)}…`);
    expect(echo("😀".repeat(40))).toBe(`${"😀".repeat(32)}…`);
  });

  it("strips control and bidi characters before counting or displaying", () => {
    expect(echo("a\u202Eb\u200Ec")).toBe("abc");
    expect(echo("\u0007bell\u009F")).toBe("bell");
  });

  it("stays correct on a huge paste", () => {
    expect(echo("x".repeat(1_000_000))).toBe(`${"x".repeat(32)}…`);
  });
});
