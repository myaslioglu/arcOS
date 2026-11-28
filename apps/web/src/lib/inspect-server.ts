import "server-only";
import { activeChain, activeNetwork, enabledInspectChains, type Address, type InspectChainKey } from "@arcos/chain";
import { DEADLINE_MS, explorerFetch, inspect, proExplorerApi, sourcifySource, withDeadline, type Report } from "@arcos/inspector";
import { budgetedFetch, dailyBudget, explorerSkipReason } from "./explorer-budget";
import { indexedExtrasFor } from "./indexed-pools-server";
import { inspectInput, inspectInputFor } from "./inspect-input";
import { processGlobal } from "./process-global";
import { inFlightGate } from "./rate-limit";
import { reportTtlMs } from "./report-cache";
import { explorerPacer, inspectRpcClient, serverRpcClient } from "./server-rpc";
import { ttlCache } from "./ttl-cache";

// Next bundles this module into more than one chunk (the route handlers get one copy, the proof page another), so
// every budget below is kept on globalThis (see process-global.ts): one RPC health record per chain, one report cache,
// two gates, one explorer pacer and one explorer budget per server process, whichever copy runs. The errors that come out
// of them may therefore come from another copy's classes; the routes tell them apart by name (see inspection-outcome.ts).

// The RPC budget against the 15 s deadline. An inspection's RPC reads run in sequential steps, with the rest of each
// step in parallel. Measured by timing the engine over a reader whose every call takes 1 s: 5 steps for a plain token
// on testnet, 7 on mainnet (with a v2 pool to check), 8 through getOwner(), 10 for an EIP-1967 or ZeppelinOS proxy
// such as EURC, 12 for a beacon proxy, and 13 at most (a clone of a beacon proxy). The lp-lock check over the position
// index adds a chain of its own after the pool lookup, up to 6 steps (the head, the index's tail in two, two multicall
// rounds, the holders' code), each a multicall or a few parallel calls. It is not held to a step count: it carries the
// inspection's deadline itself (less a second), and when that passes lp-lock is what the check from before the index
// says, which ran beside it, and the rest of the report stands (see `beforeDeadline` in @arcos/inspector). Each call tries the chain's URLs in
// order, one 3 s attempt each, and every call in this server process skips a URL that failed for the next 60 s (see
// rpc-transport.ts in @arcos/inspector). So a hung primary costs one 3 s timeout per process per minute, and an inspection meets it at
// most once: after timing out, the primary is skipped for longer than any inspection runs. With a healthy secondary
// the deepest path takes 3 s plus one round trip per step, under 7 s for 13 steps at 0.3 s each. Every endpoint
// hanging is an outage: one call alone takes 12 s on mainnet (4 × 3 s), the deadline cuts the inspection off, and it
// answers "busy" (503) without being cached. A chain other than Arc has two endpoints (the keyed provider, then the
// public RPC: rpc-urls.ts), so its worst call is 6 s.
const client = serverRpcClient();
// A clean report is kept 5 minutes, a degraded one 30 seconds (see report-cache.ts). One cache for every chain, keyed by
// chain and address, so Arc's report of an address and Base's of the same address are never one another's.
const cache = processGlobal("inspect.reportCache", () => ttlCache<Report>(reportTtlMs, 1_000));

/**
 * Thrown when this server process already runs as many uncached inspections as their gate takes: 8 on Arc (`ARC_GATE`),
 * 4 on the other chains together (`CHAINS_GATE`). Backpressure, not a hard failure.
 */
export class InspectorBusy extends Error {
  constructor() {
    super("Too many inspections are already running in this server process.");
    this.name = "InspectorBusy";
  }
}

/** Thrown for a chain this site doesn't read: not on its network, or not switched on (`NEXT_PUBLIC_INSPECT_CHAINS`). */
export class ChainNotEnabled extends Error {
  constructor() {
    super("Inspector doesn't read that chain on this site.");
    this.name = "ChainNotEnabled";
  }
}

// Caps concurrent UNCACHED inspections per server process: Arc's 8, as before there were other chains, and the other
// chains' 4, all of them together, in a gate of their own. A few clients walking uncached pages of those chains, 30 a
// minute each, fill theirs and get "busy", and never take a slot of Arc's. A cache hit or a join on an in-flight promise
// for the same chain and address never reaches either gate: ttlCache only calls its loader for genuinely new work.
const ARC_GATE = 8;
const CHAINS_GATE = 4;
const gate = processGlobal("inspect.gate", () => inFlightGate(ARC_GATE, () => new InspectorBusy()));
const chainsGate = processGlobal("inspect.chainsGate", () => inFlightGate(CHAINS_GATE, () => new InspectorBusy()));

// Blockscout's free tier allows 5 requests a second, and one inspection makes up to 4 explorer calls
// at once, plus up to 2 follow-up calls when a contract record is incomplete. A burst of inspections
// therefore waits its turn here instead of being refused and cached as "unknown". The worst case per
// server process on Arc, 8 inspections × 6 calls at 4 a second, is about 12 s, still inside the 15 s deadline;
// each request then gets at most 8 s, and none is still sent once its inspection's deadline has
// passed (see explorer-fetch.ts in @arcos/inspector). The PRO API's limit is per key, across chains, so
// every chain's calls share one window of 4 a second, in two queues (`explorerPacer` in server-rpc.ts): Arc's, always
// served first, and the other chains', which ask the explorer only while their daily budget lasts (below). The other
// chains' 4 inspections running beside Arc's 8 add to Arc's worst case only the turns already given out in the last
// second, about 1 s at most, and never their 24 calls. Theirs wait behind Arc's: with both gates full, 12 × 6 calls
// take about 18 s, so the last of theirs in line run out of time and answer "busy" (InspectionTimeout).
const explorerTurns = explorerPacer();

// The explorer calls inspections off Arc may make in a UTC day, per process (explorer-budget.ts). Arc's aren't counted.
const explorerBudget = processGlobal("inspect.explorerBudget", () => dailyBudget());

/**
 * The report for `address` on the chain `chainKey` names (Arc unless told), from this process's cache or a new
 * inspection. Rejects with `ChainNotEnabled` for a chain this site doesn't read, `InspectorBusy` or `InspectionTimeout`
 * under load, `NotAContract`, or whatever else stopped the inspection.
 */
export function cachedInspection(address: Address, chainKey: InspectChainKey = "arc"): Promise<Report> {
  if (chainKey === "arc") return cache.get(`arc:${address.toLowerCase()}`, () => gate.run(() => arcInspection(address)));
  const chain = enabledInspectChains(activeNetwork()).find((c) => c.key === chainKey);
  if (!chain) return Promise.reject(new ChainNotEnabled());
  return cache.get(`${chain.key}:${address.toLowerCase()}`, () =>
    chainsGate.run(async () => {
      const controller = new AbortController();
      // Blockscout's PRO API for the chain, the only explorer the server reads off Arc, while today's budget lasts.
      const explorerApi = proExplorerApi(chain.chainId, process.env.BLOCKSCOUT_API_KEY);
      const explorerSkipped = explorerSkipReason(explorerApi !== undefined, explorerBudget);
      // Behind Arc's reads in the explorer's queues (see `explorerTurns`).
      const fetchFn = explorerFetch(explorerTurns.low, controller.signal, budgetedFetch(explorerBudget));
      // The trade check fits its round trips inside the same deadline (DEADLINE_MS from now, as withDeadline counts it).
      const deadlineAt = Date.now() + DEADLINE_MS;
      const input = inspectInputFor(chain, address, inspectRpcClient(chain), {
        fetchFn,
        ...(explorerApi ? { explorerApi } : {}),
        deadlineAt,
        // Sourcify, free and keyless: a match there is evidence of verified source Blockscout may not have.
        verifyFallback: chain.sourcify ? sourcifySource(chain.chainId, { signal: controller.signal }) : null,
        ...(explorerSkipped ? { explorerSkipped } : {}),
      });
      return withDeadline(inspect(input), controller, DEADLINE_MS);
    }),
  );
}

/** An inspection on Arc, exactly as the server made one before there were other chains. */
async function arcInspection(address: Address): Promise<Report> {
  // Arc mainnet's public explorer refuses server requests (a Cloudflare bot check), so with a key the server
  // reads the same data from Blockscout's PRO API. Without one (local dev) it uses the public explorer. The key
  // is a runtime secret, read here on each call rather than at module load.
  const explorerApi = proExplorerApi(activeChain().id, process.env.BLOCKSCOUT_API_KEY);
  // The deadline races INSIDE the gate: gate.run()'s own `finally` frees the slot the instant the
  // race settles (timeout or real result), even if the underlying inspect() call keeps running.
  // ttlCache never caches a rejected promise (see ttl-cache.ts), so a timeout is never cached.
  // Each inspection has its own controller: when its deadline passes, its explorer requests stop,
  // and no other inspection's do.
  // The index's pools for this token, hooked v4 pools among them (at most 1.5 s, none when the index can't be read),
  // then its v4 pools' positions (1.5 s of their own, left out when they can't be read; see indexed-pools.ts). The
  // 15 s deadline starts after them.
  const { extraPools, extraPoolsTruncated, v4Positions } = await indexedExtrasFor(address);
  const controller = new AbortController();
  const fetchFn = explorerFetch(explorerTurns.high, controller.signal);
  // The trade check fits its round trips inside the same deadline (DEADLINE_MS from now, as withDeadline counts it).
  const deadlineAt = Date.now() + DEADLINE_MS;
  return withDeadline(inspect(inspectInput(address, client, fetchFn, explorerApi, extraPools, deadlineAt, v4Positions, extraPoolsTruncated)), controller, DEADLINE_MS);
}
