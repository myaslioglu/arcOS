import "server-only";
import { defineChain, type PublicClient } from "viem";
import { activeChain, activeNetwork, arcInspectChain, type InspectChain } from "@arcos/chain";
import { arcOutOfGasIsNodeAnswer, endpointHealth, inspectionClient, outOfGasIsNodeAnswerFor } from "@arcos/inspector";
import { processGlobal } from "./process-global";
import { perSecond, type PacedTurns } from "./rate-limit";
import { inspectRpcEndpoints } from "./rpc-urls";

/**
 * The server's RPC client, one per process: the inspection engine, `/api/pulse`, `/api/inspect`, `/badge` and `/t`
 * all read Arc through it, over the chain's URLs in order with one shared cooldown record (see rpc-transport.ts in @arcos/inspector).
 * CCIP-Read is off on it (see inspection-client.ts in @arcos/inspector), which matters for every route that reads contracts anyone can
 * deploy. `/api/approvals` and sign-in read Arc through their own clients instead — `approvalsRpcClient()` and
 * `authRpcClient()`, below — each with its own cooldown record, so neither can put this one's endpoints on cooldown.
 *
 * It reads an out-of-gas answer as the node's, the way Arc's nodes give one (`outOfGasIsNodeAnswerFor` with Arc's registry
 * entry): Inspector's v4 quotes each run with a gas limit of their own, and a pool anyone can create can make one run out
 * of it. That is the node's answer about one call, the same on every endpoint, so it must not fail over to, and cool,
 * every endpoint these routes share.
 */
export function serverRpcClient(): PublicClient {
  return processGlobal("server.rpcClient", () => {
    const arc = arcInspectChain(activeNetwork());
    return inspectionClient(arc.viem, processGlobal("inspect.rpcHealth", endpointHealth), outOfGasIsNodeAnswerFor(arc));
  });
}

/**
 * The Inspector's RPC client for `chain`, one per chain per process. Arc's is `serverRpcClient()`, unchanged. Any other
 * chain (Ethereum, Base, Arbitrum One, OP Mainnet) gets a client of its own over its own endpoint-health record, so one
 * chain's endpoints failing never cools another's: the keyed provider first, when the runtime secret `INSPECT_RPC_KEY`
 * is set, its key in a request header, then the chain's public RPC (rpc-urls.ts). It reads an out-of-gas answer as the
 * node's in that chain's own shapes (`outOfGasIsNodeAnswerFor`, measured per chain), and CCIP-Read is off, as on every
 * client that reads contracts anyone can deploy. The endpoints are fixed when the client is first built: a new key takes
 * a new server process (a rollout).
 */
export function inspectRpcClient(chain: InspectChain): PublicClient {
  if (chain.key === "arc") return serverRpcClient();
  return processGlobal(`inspect.rpcClient.${chain.key}`, () => {
    const endpoints = inspectRpcEndpoints(chain);
    const headers = new Map(endpoints.flatMap((e) => (e.headers ? [[e.url, e.headers] as const] : [])));
    const viem = defineChain({ ...chain.viem, rpcUrls: { default: { http: endpoints.map((e) => e.url) } } });
    return inspectionClient(viem, processGlobal(`inspect.rpcHealth.${chain.key}`, endpointHealth), outOfGasIsNodeAnswerFor(chain), (url) => headers.get(url));
  });
}

/**
 * The explorer pacer every server route shares, one per process: at most 4 explorer requests start in any second
 * (Blockscout's free tier allows 5), whichever chain they read, since the PRO API's limit is per key. It has two queues
 * over that one window (`perSecond`). What reads Arc waits in `high`: inspections and Revoke's lookups, in one queue as
 * before there were other chains, and Revoke runs only a couple of lookups at once (see approvals-server.ts), so it can't
 * crowd inspections out. Inspections of the other chains wait in `low`, which gets a turn only when nothing of Arc's
 * waits, so a burst of them never puts Arc's reads behind theirs.
 */
export function explorerPacer(): PacedTurns {
  return processGlobal("inspect.explorerQueues", () => perSecond(4));
}

/**
 * Revoke's own RPC client, one per process, built exactly like serverRpcClient() (the same URL list, in the same
 * order, and the same per-attempt timeout, CCIP-Read still off) but over its own endpoint-health record instead of
 * the Inspector's. A spoofed Approval event can make an owner's multicall fail on every endpoint (see approvals.ts's
 * resilient aggregate3 splitting): that must not put the URLs the Inspector, /badge, /t and /api/pulse share on
 * cooldown, so Revoke's failures cool only Revoke's own client.
 *
 * It also opts in to Arc's out-of-gas rule (`arcOutOfGasIsNodeAnswer`): a poisoned multicall target can make an eth_call
 * run out of gas mid-execution, which the shared classifier doesn't read as the node's answer (see rpc-transport.ts in
 * @arcos/inspector), so without this every such failure would fail over to, and cool, every endpoint on one attempt
 * instead of costing one.
 */
export function approvalsRpcClient(): PublicClient {
  return processGlobal("approvals.rpcClient", () =>
    inspectionClient(activeChain(), processGlobal("approvals.rpcHealth", endpointHealth), arcOutOfGasIsNodeAnswer),
  );
}

/**
 * Sign-in's own RPC client, one per process, built like approvalsRpcClient(): the same URL list, order and per-attempt
 * timeout, CCIP-Read off, over its own endpoint-health record, and with `arcOutOfGasIsNodeAnswer`. POST /api/auth/verify
 * is open to anyone, and a smart-wallet signature makes the server run an eth_call the request chose; an ERC-6492
 * deploy call can burn all its gas. Out of gas is then the node's answer, costing one attempt at one endpoint, and any
 * real endpoint failure cools only this record, never the one the Inspector, /api/pulse, /badge and /t share.
 */
export function authRpcClient(): PublicClient {
  return processGlobal("auth.rpcClient", () =>
    inspectionClient(activeChain(), processGlobal("auth.rpcHealth", endpointHealth), arcOutOfGasIsNodeAnswer),
  );
}

/**
 * Watchdog's own RPC client, one per process, built like authRpcClient(): the same URL list, order and per-attempt
 * timeout, CCIP-Read off, over its own endpoint-health record, and with `arcOutOfGasIsNodeAnswer`. POST /api/watches runs
 * one eth_getCode at an address the signed-in wallet chose (lib/watch-deps.ts caps it at 5 s), so an endpoint failing
 * there cools only this record, never the one the Inspector, /api/pulse, /badge and /t share, nor sign-in's.
 */
export function watchRpcClient(): PublicClient {
  return processGlobal("watch.rpcClient", () =>
    inspectionClient(activeChain(), processGlobal("watch.rpcHealth", endpointHealth), arcOutOfGasIsNodeAnswer),
  );
}
