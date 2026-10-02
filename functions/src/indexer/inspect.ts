import type { PublicClient } from "viem";
import { ARCOS, CHAINS, DEX, KNOWN_LOCKERS, type NetworkId } from "@arcos/chain";
import {
  blockscoutSource,
  endpointHealth,
  explorerFetch,
  inspect,
  inspectionClient,
  outOfGasIsNodeAnswer,
  proExplorerApi,
  viemReader,
  withDeadline,
  type PoolScan,
} from "@arcos/inspector";
import type { ExplorerBudget, InspectToken } from "./run";

/** Thrown in place of an explorer request once the day's budget is spent; the inspector reads it as the explorer being down. */
export class ExplorerBudgetSpent extends Error {
  constructor() {
    super("The explorer budget for today is spent.");
    this.name = "ExplorerBudgetSpent";
  }
}

/** A fetch that spends one call of `budget` per request, and refuses once there is none left. */
export function budgetedFetch(budget: ExplorerBudget, fetchFn: typeof fetch = fetch): typeof fetch {
  return (input, init) => (budget.spend() ? fetchFn(input, init) : Promise.reject(new ExplorerBudgetSpent()));
}

/** At most one explorer request starts every 250 ms: 4 a second, the web server's pace (Blockscout allows 5). */
export function spacedTurns(gapMs = 250, now: () => number = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): () => Promise<void> {
  let next = 0;
  let queue: Promise<void> = Promise.resolve();
  return () => {
    const turn = queue.then(async () => {
      const at = Math.max(now(), next);
      next = at + gapMs;
      const wait = at - now();
      if (wait > 0) await sleep(wait);
    });
    queue = turn;
    return turn;
  };
}

/** How long one inspection may take, as on the site (deadline.ts). */
export const INSPECTION_MS = 15_000;

/**
 * The inspector the indexer runs, with what the site's server gives its own (apps/web/src/lib/inspect-input.ts): the
 * network's RPC URLs in order with cooldowns, CCIP-Read off, and an out-of-gas answer read as the node's; Blockscout's
 * PRO API with the key, or no explorer without one (Arc mainnet's public explorer refuses servers). Explorer calls are
 * counted against the day's budget, and the inspection is cut off after 15 s.
 */
export function liveInspector(options: { network: NetworkId; apiKey?: string; client?: PublicClient; fetchFn?: typeof fetch }): InspectToken {
  const { network } = options;
  const chain = CHAINS[network];
  const client = options.client ?? inspectionClient(chain, endpointHealth(), outOfGasIsNodeAnswer);
  const api = proExplorerApi(chain.id, options.apiKey);
  const turn = spacedTurns();
  return async (address, extraPools, budget) => {
    const controller = new AbortController();
    let scan: PoolScan | null = null;
    const explorer =
      api && budget ? blockscoutSource(api.url, explorerFetch(turn, controller.signal, budgetedFetch(budget, options.fetchFn)), api.apiKey) : null;
    const report = await withDeadline(
      inspect({
        address,
        network,
        reader: viemReader(client),
        explorer,
        dex: DEX[network],
        knownLockers: KNOWN_LOCKERS[network],
        explorerBase: chain.blockExplorers?.default.url ?? "",
        arcosTokenFactory: ARCOS[network]?.tokenFactory ?? null,
        extraPools,
        // The trade check fits its round trips inside the same deadline.
        deadlineAt: Date.now() + INSPECTION_MS,
        onPools: (found) => {
          scan = found;
        },
      }),
      controller,
      INSPECTION_MS,
    );
    return { report, scan };
  };
}
