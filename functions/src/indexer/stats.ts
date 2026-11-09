import { decodeEventLog, toEventSelector, type Abi, type Hex } from "viem";
import { ARCOS, FEE_KEYS, PREVIOUS_MULTISENDS, feeControllerAbi, multisendAbi, tokenFactoryAbi, type Address, type NetworkId } from "@arcos/chain";
import { amountFromString, amountToString, type StatsDoc, type StatsFees, type StatsTotals } from "@arcos/data";
import type { RawLog } from "./events";

// The usage counter's pure half (Stats, v1): which contracts and events it reads, how a window's logs are decoded, and how
// they are folded into the running totals. No Firestore here: stats-store.ts applies a window, stats-run.ts loops over
// windows.

/**
 * Wallets whose own transactions are left out of the on-chain counts: the ArcOS project wallet, which tests Mint and Drop
 * on mainnet and would otherwise count as usage. Their events are counted apart (`StatsDoc.excluded`), never added to a
 * total or to a fee. The public answer says the project wallet is left out (statsAnswer's notes), and names no address.
 * Lowercase compare: the list holds the address as written on the explorer.
 */
export const STATS_EXCLUDED_WALLETS: readonly Address[] = ["0x463A81a017326E9029DcCA2a2d9AA42599Bef12c"];

const eventOf = (abi: Abi, name: string): Abi => abi.filter((item) => item.type === "event" && item.name === name);
const selector = (abi: Abi): Hex => {
  const event = abi.find((item) => item.type === "event");
  if (!event || event.type !== "event") throw new Error("no event in the ABI");
  return toEventSelector(event);
};

const ABIS = {
  tokenCreated: eventOf(tokenFactoryAbi as Abi, "TokenCreated"),
  drop: eventOf(multisendAbi as Abi, "Drop"),
  keyAdded: eventOf(feeControllerAbi as Abi, "KeyAdded"),
  feeChanged: eventOf(feeControllerAbi as Abi, "FeeChanged"),
} as const;

/** topic0 of each event Stats reads. */
export const STATS_TOPICS = {
  tokenCreated: selector(ABIS.tokenCreated),
  drop: selector(ABIS.drop),
  keyAdded: selector(ABIS.keyAdded),
  feeChanged: selector(ABIS.feeChanged),
} as const;

export type StatsSourceKind = keyof typeof ABIS;

/** One contract Stats reads, with the one event it reads from it. */
export type StatsSource = { kind: StatsSourceKind; address: Address; topic0: Hex; abi: Abi };

/**
 * The contracts and events Stats counts: TokenFactory `TokenCreated`; `Drop` of the current Multisend and every previous
 * one; the FeeController's `KeyAdded` and `FeeChanged`, which rebuild the fee a Mint or a Drop paid at its block. Four
 * addresses on mainnet. None where the network has no ArcOS contracts.
 */
export function statsSources(network: NetworkId): StatsSource[] {
  const arcos = ARCOS[network];
  if (!arcos) return [];
  const multisends = [...new Set([arcos.multisend, ...PREVIOUS_MULTISENDS[network]].map((a) => a.toLowerCase()))];
  const source = (kind: StatsSourceKind, address: string): StatsSource => ({ kind, address: address as Address, topic0: STATS_TOPICS[kind], abi: ABIS[kind] });
  return [
    source("tokenCreated", arcos.tokenFactory),
    ...multisends.map((a) => source("drop", a)),
    source("keyAdded", arcos.feeController),
    source("feeChanged", arcos.feeController),
  ];
}

/** Where a log sits on the chain, and when (Arc's `blockTimestamp`, in seconds; null when the node left it out). */
type Position = { block: number; logIndex: number; timestamp: number | null };

export type StatsEvent =
  | (Position & { kind: "tokenCreated"; creator: string; mintable: boolean; burnable: boolean })
  | (Position & { kind: "drop"; sender: string; token: string; recipients: bigint; failedCount: bigint })
  | (Position & { kind: "fee"; key: string; value: bigint });

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FEE_KEY_LOWER = {
  mintFlat: FEE_KEYS.MINT_FLAT.toLowerCase(),
  dropPerRecipient: FEE_KEYS.DROP_PER_RECIPIENT.toLowerCase(),
  dropMin: FEE_KEYS.DROP_MIN.toLowerCase(),
} as const;

const quantity = (hex: Hex | undefined): number | null => (hex === undefined ? null : Number(BigInt(hex)));

/** One log as an event, or null: a removed log, an emitter or topic Stats doesn't read, or a log that doesn't decode. */
export function decodeStatsLog(log: RawLog, sources: readonly StatsSource[]): StatsEvent | null {
  if (log.removed) return null;
  const topic0 = log.topics[0]?.toLowerCase();
  const source = sources.find((s) => s.address.toLowerCase() === log.address.toLowerCase() && s.topic0.toLowerCase() === topic0);
  if (!source) return null;
  let args: Record<string, unknown>;
  try {
    args = decodeEventLog({ abi: source.abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true }).args as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  const at: Position = { block: Number(BigInt(log.blockNumber)), logIndex: Number(BigInt(log.logIndex)), timestamp: quantity(log.blockTimestamp) };
  switch (source.kind) {
    case "tokenCreated":
      return { ...at, kind: "tokenCreated", creator: (args.creator as string).toLowerCase(), mintable: args.mintable === true, burnable: args.burnable === true };
    case "drop":
      return {
        ...at,
        kind: "drop",
        sender: (args.sender as string).toLowerCase(),
        token: (args.token as string).toLowerCase(),
        recipients: args.recipients as bigint,
        failedCount: args.failedCount as bigint,
      };
    case "keyAdded":
    case "feeChanged":
      return { ...at, kind: "fee", key: (args.key as string).toLowerCase(), value: args.value as bigint };
  }
}

/**
 * The events of one window, in chain order (block, then log index), whatever order the node sent them in. A log outside
 * [from, to] is left out, and so is a second log at the same block and log index: a window counts each log once.
 */
export function decodeStatsLogs(logs: readonly RawLog[], sources: readonly StatsSource[], window: { from: number; to: number }): StatsEvent[] {
  const seen = new Set<string>();
  const events: StatsEvent[] = [];
  for (const log of logs) {
    const event = decodeStatsLog(log, sources);
    if (!event || event.block < window.from || event.block > window.to) continue;
    const id = `${event.block}:${event.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    events.push(event);
  }
  return events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

/** What the fold carries from window to window: the fee values, the totals, and what the left-out wallets did. */
export type StatsState = { fees: StatsFees<bigint>; totals: StatsTotals<bigint>; excluded: { tokensCreated: number; drops: number } };

export const emptyStatsState = (): StatsState => ({
  fees: { mintFlat: null, dropPerRecipient: null, dropMin: null },
  totals: {
    tokensCreated: 0,
    byTemplate: { standard: 0, mintable: 0, burnable: 0, mintableBurnable: 0 },
    drops: 0,
    dropsNative: 0,
    dropsToken: 0,
    rowsSubmitted: 0,
    rowsDelivered: 0,
    rowsFailed: 0,
    feesMint: 0n,
    feesDrop: 0n,
  },
  excluded: { tokensCreated: 0, drops: 0 },
});

const optional = (a: string | null): bigint | null => (a === null ? null : amountFromString(a));
const text = (a: bigint | null): string | null => (a === null ? null : amountToString(a));

/** The state a stored doc holds. */
export function stateOfDoc(doc: Pick<StatsDoc, "fees" | "totals" | "excluded">): StatsState {
  return {
    fees: { mintFlat: optional(doc.fees.mintFlat), dropPerRecipient: optional(doc.fees.dropPerRecipient), dropMin: optional(doc.fees.dropMin) },
    totals: { ...doc.totals, byTemplate: { ...doc.totals.byTemplate }, feesMint: amountFromString(doc.totals.feesMint), feesDrop: amountFromString(doc.totals.feesDrop) },
    excluded: { ...doc.excluded },
  };
}

/** The doc fields a state is stored as: amounts as decimal strings. */
export function docFieldsOf(state: StatsState): Pick<StatsDoc, "fees" | "totals" | "excluded"> {
  return {
    fees: { mintFlat: text(state.fees.mintFlat), dropPerRecipient: text(state.fees.dropPerRecipient), dropMin: text(state.fees.dropMin) },
    totals: { ...state.totals, byTemplate: { ...state.totals.byTemplate }, feesMint: amountToString(state.totals.feesMint), feesDrop: amountToString(state.totals.feesDrop) },
    excluded: { ...state.excluded },
  };
}

/** What a window added to one UTC day (YYYY-MM-DD). */
export type DayCounts = { tokensCreated: number; drops: number; rowsDelivered: number };

/** What a window added in all, as the run line reports it. */
/** `undated` counts the events added to the totals that carried no block time, so they are in no day bucket. */
export type StatsDelta = { tokensCreated: number; drops: number; undated: number };

/** The UTC day of a block timestamp in seconds. */
export const dayOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/**
 * Folds a window's events (from `decodeStatsLogs`, in chain order) into `state`, which it does not change:
 * - a fee event sets the fee its key names (the others are ignored), so every Mint and Drop after it is priced with it;
 * - TokenCreated adds one to the total and to the template its flags name, and the Mint fee as of then;
 * - Drop adds one batch, its rows (delivered is recipients less failed, never under 0) and `max(rows x per-recipient, minimum)`;
 * - an event whose creator or sender is in `excluded` goes to `state.excluded` and to nothing else.
 * Fees are read in log order, so a fee changed in the same block as a Mint prices that Mint by its log index. A fee not
 * yet seen prices as 0 (Stats starts at the FeeController's deployment, so none is missed). `days` holds the counts of
 * events that carry a block time; one without is in the totals but in no day.
 */
export function foldStats(
  state: StatsState,
  events: readonly StatsEvent[],
  excluded: readonly string[] = STATS_EXCLUDED_WALLETS,
): { state: StatsState; delta: StatsDelta; days: Map<string, DayCounts> } {
  const left = new Set(excluded.map((a) => a.toLowerCase()));
  const next: StatsState = {
    fees: { ...state.fees },
    totals: { ...state.totals, byTemplate: { ...state.totals.byTemplate } },
    excluded: { ...state.excluded },
  };
  const delta: StatsDelta = { tokensCreated: 0, drops: 0, undated: 0 };
  const days = new Map<string, DayCounts>();
  const day = (e: Position): DayCounts | null => {
    if (e.timestamp === null) {
      delta.undated++;
      return null;
    }
    const key = dayOf(e.timestamp);
    let counts = days.get(key);
    if (!counts) days.set(key, (counts = { tokensCreated: 0, drops: 0, rowsDelivered: 0 }));
    return counts;
  };

  for (const e of events) {
    if (e.kind === "fee") {
      if (e.key === FEE_KEY_LOWER.mintFlat) next.fees.mintFlat = e.value;
      else if (e.key === FEE_KEY_LOWER.dropPerRecipient) next.fees.dropPerRecipient = e.value;
      else if (e.key === FEE_KEY_LOWER.dropMin) next.fees.dropMin = e.value;
      continue;
    }
    if (e.kind === "tokenCreated") {
      if (left.has(e.creator)) {
        next.excluded.tokensCreated++;
        continue;
      }
      next.totals.tokensCreated++;
      const template = e.mintable ? (e.burnable ? "mintableBurnable" : "mintable") : e.burnable ? "burnable" : "standard";
      next.totals.byTemplate[template]++;
      next.totals.feesMint += next.fees.mintFlat ?? 0n;
      delta.tokensCreated++;
      const d = day(e);
      if (d) d.tokensCreated++;
      continue;
    }
    if (left.has(e.sender)) {
      next.excluded.drops++;
      continue;
    }
    const rows = Number(e.recipients);
    const failed = Math.min(rows, Number(e.failedCount));
    next.totals.drops++;
    if (e.token === ZERO_ADDRESS) next.totals.dropsNative++;
    else next.totals.dropsToken++;
    next.totals.rowsSubmitted += rows;
    next.totals.rowsDelivered += rows - failed;
    next.totals.rowsFailed += failed;
    const quoted = e.recipients * (next.fees.dropPerRecipient ?? 0n);
    const minimum = next.fees.dropMin ?? 0n;
    next.totals.feesDrop += quoted < minimum ? minimum : quoted;
    delta.drops++;
    const d = day(e);
    if (d) {
      d.drops++;
      d.rowsDelivered += rows - failed;
    }
  }
  return { state: next, delta, days };
}
