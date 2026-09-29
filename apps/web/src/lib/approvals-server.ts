import "server-only";
import { multicall3Abi, type Address } from "viem";
import { activeChain, activeNetwork } from "@arcos/chain";
import { ApprovalsUnavailable, loadApprovals, logsPageUrl, readLogsPage, type ApprovalsAnswer } from "./approvals";
import { withDeadline } from "./deadline";
import { explorerFetch } from "./explorer-fetch";
import { proLogsApi } from "./inspect-input";
import { processGlobal } from "./process-global";
import { inFlightGate } from "./rate-limit";
import { approvalsRpcClient, explorerPacer } from "./server-rpc";
import { ttlCache } from "./ttl-cache";

/** This server process is already running its most approval lookups at once: backpressure, answered 503. */
export class ApprovalsBusy extends Error {
  constructor() {
    super("Too many approval lookups are already running in this server process.");
    this.name = "ApprovalsBusy";
  }
}

// One cache and one gate per server process, whichever bundled copy of this module runs (see process-global.ts).
// Each owner's answer is kept for 60 s; a failed lookup is dropped, never cached (see ttl-cache.ts).
const cache = processGlobal("approvals.cache", () => ttlCache<ApprovalsAnswer>(60_000));
// At most four uncached lookups at once: each pages the explorer sequentially, one request waited on at a time, on
// the pacer the Inspector shares.
const gate = processGlobal("approvals.gate", () => inFlightGate(4, () => new ApprovalsBusy()));

/**
 * The owner's live ERC-20 approvals. The logs come from Blockscout's PRO API with the Inspector's key when one is set
 * (`BLOCKSCOUT_API_KEY`, read on each call and sent only as a bearer header), else from the network's public explorer,
 * which refuses servers on mainnet. Explorer requests wait their turn on the Inspector's pacer, each ends after 8 s
 * (explorer-fetch.ts), and the whole lookup after 15 s (deadline.ts). The allowances and token details come from
 * Revoke's own RPC client (`approvalsRpcClient()`, its own endpoint-health record, never the Inspector's shared
 * one): a clean multicall is one Multicall3 call, and one a spoofed Approval event poisons is split and retried
 * within its own budget (see `liveApprovals` in approvals.ts) rather than cooling the Inspector's endpoints. When
 * the first Multicall3 call fails, one block-number read on the same client tells an RPC outage (a 503) from a
 * poisoned call (the halving goes on, and the answer is marked truncated).
 */
export function cachedApprovals(owner: Address): Promise<ApprovalsAnswer> {
  const chain = activeChain();
  const api = proLogsApi(chain.id, process.env.BLOCKSCOUT_API_KEY) ?? {
    url: `${chain.blockExplorers?.default.url ?? ""}/api`,
    apiKey: "",
  };
  const multicall3 = chain.contracts?.multicall3?.address;
  // Checked before anything else: without Multicall3 no call could ever be answered, and the canary, finding the RPC
  // up, would read every call as poisoned and pass an empty list off as merely truncated.
  if (!multicall3) return Promise.reject(new ApprovalsUnavailable("This chain has no Multicall3."));
  return cache.get(owner.toLowerCase(), () =>
    gate.run(() => {
      const controller = new AbortController();
      const fetchFn = explorerFetch(explorerPacer(), controller.signal);
      const client = approvalsRpcClient();
      return withDeadline(
        loadApprovals(owner, {
          network: activeNetwork(),
          readPage: (fromBlock) => readLogsPage(logsPageUrl(api.url, owner, fromBlock), fetchFn, api.apiKey),
          aggregate: async (calls) => {
            // A backstop: once the 15 s deadline has aborted this lookup, no further attempt starts. With the one
            // clock loadApprovals keeps, MULTICALL_TIME_BUDGET_MS (9 s from the lookup's start) already stops every
            // attempt but the first long before the deadline fires, so this only matters when that clock doesn't
            // keep pace with the deadline's timer: an injected clock that steps backwards or stands still, as a
            // test's can. (withDeadline frees the gate's slot when it fires either way.)
            controller.signal.throwIfAborted();
            return client.readContract({
              address: multicall3,
              abi: multicall3Abi,
              functionName: "aggregate3",
              args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
            });
          },
          canary: async () => {
            // Asked when the first aggregate3 call fails, and that call, exempt from the time budget, can still be
            // running when the deadline fires: once the route has answered 503, no read is sent.
            controller.signal.throwIfAborted();
            // cacheTime 0: a live read. viem would otherwise answer from the block number it read in the last few
            // seconds, which says nothing about whether the RPC answers now.
            await client.getBlockNumber({ cacheTime: 0 });
          },
        }),
        controller,
      );
    }),
  );
}
