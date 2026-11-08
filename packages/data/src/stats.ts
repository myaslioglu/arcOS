import { ARCOS, PREVIOUS_MULTISENDS, USAGE_EVENTS, explorerUrl } from "@arcos/chain";
import type { StatsDoc } from "./docs";
import type { TimestampLike } from "./timestamps";

// What GET /api/stats answers and the Stats window reads: the usage counter's doc turned into a list of counts, each with
// the date it counts from and where it comes from. Pure. Fee totals are stored in the doc and never leave it here.

/** One part of a count: a template of Mint, or native against token Drops. */
export type StatsPart = { id: string; label: string; value: number };

/** How to check a number on chain: the contracts to read, the event to count, and a link to each contract's logs. */
export type StatsVerify = {
  event: string;
  /** What to do with the event's fields to get the number. */
  how: string;
  contracts: { label: string; address: string; explorer: string }[];
};

export type StatsCount = {
  id: string;
  label: string;
  value: number;
  /** The date (UTC, YYYY-MM-DD) the count starts from, or null when the first record isn't known. */
  since: string | null;
  /** onchain: anyone can recount it from the chain. server: kept by ArcOS in its own data. */
  source: "onchain" | "server";
  parts?: StatsPart[];
  verify?: StatsVerify;
};

export type StatsAnswer = {
  version: 1;
  network: "arc-mainnet";
  /** The last block counted, when that was written, and how many blocks counting is behind the chain's head. Null before counting began. */
  asOf: { block: number; at: string; behind: number } | null;
  counts: StatsCount[];
  notes: string[];
};

export const STATS_NOTES = [
  "Counts are of Arc mainnet only. Testnet is not counted.",
  "Counts leave out the ArcOS project wallet's own transactions, so the explorer's totals can be a little higher.",
  "Drop counts rows, not unique wallets: one wallet can be a row in many drops.",
  "Automated counts, refreshed about every minute. Counts marked server are kept by ArcOS in its own data, not read from the chain.",
] as const;

/** A stored count as a number: anything but a non-negative whole number reads as 0, so one bad field can't break the answer. */
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);

/** The UTC date of a stored time, or null when it isn't one. */
function dateOf(at: TimestampLike | null | undefined): string | null {
  const ms = at && typeof at.toMillis === "function" ? at.toMillis() : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

const logsLink = (address: string): string => `${explorerUrl("address", address, "mainnet")}?tab=logs`;
const contract = (label: string, address: string) => ({ label, address, explorer: logsLink(address) });

/** The doc as the public answer; a missing doc (counting hasn't begun) is an answer with no counts. */
export function statsAnswer(doc: StatsDoc | null): StatsAnswer {
  const notes = [...STATS_NOTES];
  if (!doc) return { version: 1, network: "arc-mainnet", asOf: null, counts: [], notes };

  const factory = ARCOS.mainnet?.tokenFactory;
  const multisends = [ARCOS.mainnet?.multisend, ...PREVIOUS_MULTISENDS.mainnet].filter((a): a is `0x${string}` => typeof a === "string");
  const verifyMint: StatsVerify | undefined = factory
    ? { event: USAGE_EVENTS.tokenCreated, how: "Count the events.", contracts: [contract("TokenFactory", factory)] }
    : undefined;
  const dropContracts = multisends.map((a, i) => contract(i === 0 ? "Multisend" : "Multisend (previous)", a));
  const verifyDrop = (how: string): StatsVerify => ({ event: USAGE_EVENTS.drop, how, contracts: dropContracts });

  const t = doc.totals;
  const onchainSince = dateOf(doc.onchainSince);
  const counts: StatsCount[] = [
    {
      id: "tokens_created",
      label: "Tokens created with Mint",
      value: count(t?.tokensCreated),
      since: onchainSince,
      source: "onchain",
      parts: [
        { id: "standard", label: "Standard", value: count(t?.byTemplate?.standard) },
        { id: "mintable", label: "Mintable", value: count(t?.byTemplate?.mintable) },
        { id: "burnable", label: "Burnable", value: count(t?.byTemplate?.burnable) },
        { id: "mintable_burnable", label: "Mintable and burnable", value: count(t?.byTemplate?.mintableBurnable) },
      ],
      ...(verifyMint ? { verify: verifyMint } : {}),
    },
    {
      id: "drops",
      label: "Drop transactions",
      value: count(t?.drops),
      since: onchainSince,
      source: "onchain",
      parts: [
        { id: "native", label: "USDC", value: count(t?.dropsNative) },
        { id: "token", label: "Tokens", value: count(t?.dropsToken) },
      ],
      verify: verifyDrop("Count the events: one Drop is one batch transaction."),
    },
    {
      id: "recipients_delivered",
      label: "Recipients delivered",
      value: count(t?.rowsDelivered),
      since: onchainSince,
      source: "onchain",
      verify: verifyDrop("Add up `recipients` minus `failedCount` over the events."),
    },
    {
      id: "rows_failed",
      label: "Rows that failed",
      value: count(t?.rowsFailed),
      since: onchainSince,
      source: "onchain",
      verify: verifyDrop("Add up `failedCount` over the events."),
    },
  ];

  const s = doc.server;
  if (s) {
    const since = s.since ?? { users: null, watches: null, tokens: null };
    counts.push(
      { id: "wallets_signed_in", label: "Wallets signed in", value: count(s.users), since: dateOf(since.users), source: "server" },
      { id: "telegram_linked", label: "Wallets with Telegram alerts", value: count(s.telegramLinked), since: dateOf(since.users), source: "server" },
      { id: "watches", label: "Token watches", value: count(s.watches), since: dateOf(since.watches), source: "server" },
      { id: "tokens_indexed", label: "Tokens indexed by Radar", value: count(s.tokensIndexed), since: dateOf(since.tokens), source: "server" },
      { id: "tokens_inspected", label: "Tokens inspected automatically", value: count(s.tokensInspected), since: dateOf(since.tokens), source: "server" },
    );
  }

  const at = doc.updatedAt && typeof doc.updatedAt.toDate === "function" ? doc.updatedAt.toDate().toISOString() : null;
  const block = count(doc.block);
  return {
    version: 1,
    network: "arc-mainnet",
    asOf: at === null ? null : { block, at, behind: Math.max(0, count(doc.head) - block) },
    counts,
    notes,
  };
}
