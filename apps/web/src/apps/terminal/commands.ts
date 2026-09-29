import { formatGwei, getAddress, isAddress, type Address } from "viem";
import { explorerUrl, formatUsdc } from "@arcos/chain";
import { roadmapEntries, type AppManifest, type ThemePreference } from "@arcos/shell/core";
import { shortAddress } from "@/lib/format";

/** One line of the scrollback. `href` is only ever an explorer link this module built from a checked address. */
export type Line = { kind: "in" | "out" | "err"; text: string; href?: string };

/** What a command answers: lines to print, or `clear` to empty the screen. */
export type Outcome = { lines: Line[]; clear?: true };

/**
 * Everything a command may use, handed in so each one can be tested with stubs. Reads go through the public RPC
 * client the other apps use, never a server route; no command signs or sends anything.
 */
export type TermEnv = {
  apps: readonly AppManifest[];
  open: (appId: string, params?: Record<string, string>) => boolean;
  account: { address?: string; chainId?: number };
  chain: { id: number; name: string };
  read: {
    balance: (address: Address) => Promise<bigint>;
    latestBlock: () => Promise<{ number: bigint; timestamp: bigint; baseFeePerGas: bigint | null; txCount: number }>;
  };
  setTheme: (preference: ThemePreference) => void;
  /** This window's commands so far, the current one last. */
  history: readonly string[];
  now: () => number;
};

/** The gas a plain transfer of native USDC uses. */
export const PLAIN_TRANSFER_GAS = 21_000n;

const NOT_AN_ADDRESS = "That isn't an address.";
const READ_FAILED = "Couldn't read the chain. Try again.";
const THEMES: readonly ThemePreference[] = ["light", "dark", "system"];

const out = (...text: string[]): Outcome => ({ lines: text.map((t) => ({ kind: "out", text: t })) });
const err = (text: string): Outcome => ({ lines: [{ kind: "err", text }] });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What is stripped from anything shown back to the visitor: C0/C1 control characters (`\p{Cc}`), every Unicode format
 * character (`\p{Cf}`), and the line and paragraph separators (`\p{Zl}`, U+2028, and `\p{Zp}`, U+2029). That is the
 * same set `cleanLabel` (`@arcos/inspector`) strips from an on-chain label. The format characters are the bidi controls
 * (ALM; LRM/RLM; the LRE/RLE/PDF/LRO/RLO block; the LRI/RLI/FSI/PDI block) and the zero-width ones (U+200B ZWSP, U+200C
 * ZWNJ, U+200D ZWJ, U+2060 word joiner, U+FEFF BOM). A typed or pasted character from any of these can never reorder,
 * hide part of, inject a control sequence into, break in two, or silently vanish from a displayed line.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Strips C0/C1 control, Unicode format, and line and paragraph separator characters. Used for the scrollback's "in"
 * line, by `echo()`, and by the `history` command. */
export function sanitize(text: string): string {
  return text.replace(UNSAFE_CHARS, "");
}

/**
 * Typed text as an answer may quote it: at most 32 characters, control and bidi characters stripped
 * first, so a pasted essay isn't echoed back whole and can't carry a hidden or reordering character.
 * The cheap slice before the code-point split keeps a huge paste from making this function itself
 * slow.
 */
export function echo(text: string): string {
  const clean = sanitize(text.length > 256 ? text.slice(0, 256) : text);
  const chars = Array.from(clean);
  return chars.length > 32 ? `${chars.slice(0, 32).join("")}…` : clean;
}

function address(text: string | undefined): Address | null {
  return text && isAddress(text, { strict: false }) ? getAddress(text) : null;
}

type Command = {
  name: string;
  usage: string;
  about: string;
  run: (args: string[], env: TermEnv) => Outcome | Promise<Outcome>;
};

// Looked up with Array#find, never as object keys, so no typed name ever reaches a prototype.
const COMMANDS: Command[] = [
  {
    name: "help",
    usage: "help",
    about: "Lists the commands",
    run: () => out(...COMMANDS.map((c) => `${c.usage.padEnd(25)}${c.about}`)),
  },
  {
    name: "open",
    usage: "open [app]",
    about: "Opens an app, or lists the apps",
    run: (args, env) => {
      const [id] = args;
      if (!id) return out(...env.apps.map((m) => `${m.id.padEnd(12)}${m.name}${m.comingSoon ? " (work in progress)" : ""}`));
      const m = env.apps.find((a) => a.id === id.toLowerCase());
      if (!m) return err(`No app called ${echo(id)}. Type open to list them.`);
      if (!env.open(m.id)) return err(`Couldn't open ${m.name}.`);
      return out(m.comingSoon ? `Opened ${m.name} (work in progress).` : `Opened ${m.name}.`);
    },
  },
  {
    name: "inspect",
    usage: "inspect <address>",
    about: "Opens Inspector on a token",
    run: (args, env) => {
      if (!args[0]) return err("Usage: inspect <address>");
      const token = address(args[0]);
      if (!token) return err(NOT_AN_ADDRESS);
      env.open("inspector", { token });
      return out(`Opened Inspector for ${shortAddress(token)}.`);
    },
  },
  {
    name: "approvals",
    usage: "approvals [address]",
    about: "Opens Revoke for an address, or for your wallet",
    run: (args, env) => {
      const owner = args[0] ? address(args[0]) : address(env.account.address);
      if (args[0] && !owner) return err(NOT_AN_ADDRESS);
      env.open("revoke", owner ? { owner } : {});
      return out(owner ? `Opened Revoke for ${shortAddress(owner)}.` : "Opened Revoke.");
    },
  },
  {
    name: "balance",
    usage: "balance [address]",
    about: "USDC balance, your wallet's by default",
    run: async (args, env) => {
      const target = args[0] ? address(args[0]) : address(env.account.address);
      if (args[0] && !target) return err(NOT_AN_ADDRESS);
      if (!target) return err("No wallet connected. Try balance <address>.");
      try {
        const wei = await env.read.balance(target);
        return {
          lines: [{ kind: "out", text: `${shortAddress(target)}: ${formatUsdc(wei)} USDC`, href: explorerUrl("address", target) }],
        };
      } catch {
        return err(READ_FAILED);
      }
    },
  },
  {
    name: "block",
    usage: "block",
    about: "The latest block",
    run: async (_args, env) => {
      try {
        const b = await env.read.latestBlock();
        const age = Math.max(0, Math.round(env.now() / 1000 - Number(b.timestamp)));
        return out(`Block ${b.number.toLocaleString("en-US")} · ${age} s ago · ${plural(b.txCount, "transaction")}`);
      } catch {
        return err(READ_FAILED);
      }
    },
  },
  {
    name: "gas",
    usage: "gas",
    about: "The base fee, and what a plain transfer costs",
    run: async (_args, env) => {
      try {
        const { baseFeePerGas } = await env.read.latestBlock();
        if (baseFeePerGas === null) return out("This network doesn't report a base fee.");
        return out(
          `Base fee: ${formatGwei(baseFeePerGas)} gwei`,
          `A plain USDC transfer costs ${formatUsdc(baseFeePerGas * PLAIN_TRANSFER_GAS)} USDC at this base fee.`,
        );
      } catch {
        return err(READ_FAILED);
      }
    },
  },
  {
    name: "whoami",
    usage: "whoami",
    about: "Your wallet and its network",
    run: (_args, env) => {
      const who = address(env.account.address);
      if (!who) return out("No wallet connected");
      const network =
        env.account.chainId === env.chain.id
          ? env.chain.name
          : `another network (chain ${env.account.chainId ?? "unknown"})`;
      return out(who, `On ${network}`);
    },
  },
  {
    name: "theme",
    usage: "theme light|dark|system",
    about: "Sets the theme",
    run: (args, env) => {
      const choice = THEMES.find((t) => t === (args[0] ?? "").toLowerCase());
      if (!choice) return err("Usage: theme light|dark|system");
      env.setTheme(choice);
      return out(choice === "system" ? "Theme set to match your system." : `Theme set to ${choice}.`);
    },
  },
  {
    name: "roadmap",
    usage: "roadmap",
    about: "The apps on the way",
    run: (_args, env) => {
      const entries = roadmapEntries(env.apps);
      if (entries.length === 0) return out("No apps are in progress.");
      return out(...entries.map(({ app, stage }) => `${app.name.padEnd(12)}${stage.padEnd(18)}${app.blurb}`));
    },
  },
  {
    name: "clear",
    usage: "clear",
    about: "Clears the screen (Ctrl L)",
    run: () => ({ lines: [], clear: true }),
  },
  {
    name: "history",
    usage: "history",
    about: "This window's commands",
    run: (_args, env) => out(...env.history.map((cmd, i) => `${String(i + 1).padStart(3)}  ${sanitize(cmd)}`)),
  },
  {
    name: "about",
    usage: "about",
    about: "What 4rc.OS is",
    run: () =>
      out(
        "4rc.OS is a desktop for Circle's Arc network: inspect a token, mint one and send to many wallets at once.",
        "Type open about for more.",
      ),
  },
];

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);

/** A typed line as a command name, in lower case, and its arguments as typed; null for a blank line. */
export function parseCommand(raw: string): { name: string; args: string[] } | null {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const [name, ...args] = words;
  return { name: name.toLowerCase(), args };
}

/** Runs one typed line. Every answer is text; a command that throws answers with a sentence, never its error. */
export async function runCommand(raw: string, env: TermEnv): Promise<Outcome> {
  const parsed = parseCommand(raw);
  if (!parsed) return { lines: [] };
  const command = COMMANDS.find((c) => c.name === parsed.name);
  if (!command) return err(`Unknown command: ${echo(parsed.name)}. Type help.`);
  try {
    return await command.run(parsed.args, env);
  } catch {
    return err("That command failed. Try again.");
  }
}

/** Tab's candidates for the typed line: command names, then app ids after `open` and themes after `theme`. */
export function complete(input: string, appIds: readonly string[]): string[] {
  const text = input.replace(/^\s+/, "");
  const space = text.indexOf(" ");
  if (space === -1) {
    const word = text.toLowerCase();
    return word ? COMMAND_NAMES.filter((n) => n.startsWith(word)) : [];
  }
  const name = text.slice(0, space).toLowerCase();
  const rest = text.slice(space + 1).replace(/^\s+/, "").toLowerCase();
  if (rest.includes(" ")) return [];
  const pool: readonly string[] = name === "open" ? appIds : name === "theme" ? THEMES : [];
  return pool.filter((w) => w.startsWith(rest)).map((w) => `${name} ${w}`);
}
