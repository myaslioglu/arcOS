import "server-only";
import { addWatch, consumeLinkCode, createLinkCode, listWatches, removeWatch, unlinkChat, unlinkWallet } from "@arcos/data/server";
import { withDeadline } from "@arcos/inspector";
import { authDeps } from "./auth-deps";
import { processGlobal } from "./process-global";
import { watchRpcClient } from "./server-rpc";
import type { WatchDeps } from "./watch-server";

/** How long POST /api/watches waits for eth_getCode before answering that Arc couldn't be reached. */
const CODE_DEADLINE_MS = 5_000;

/**
 * What the Watchdog routes run on in the app: the Firestore stores in the named database arcos (@arcos/data/server),
 * sign-in's deps for the session (lib/auth-deps.ts), Watchdog's own RPC client for the contract check (watchRpcClient():
 * its own endpoint health, CCIP-Read off, each read capped at 5 s), the real clock and process.env. One per process.
 * The Admin SDK starts on the first store call, not here.
 */
export function watchDeps(): WatchDeps {
  return processGlobal("watch.deps", () => ({
    store: { addWatch, removeWatch, listWatches, createLinkCode, consumeLinkCode, unlinkWallet, unlinkChat },
    auth: authDeps(),
    hasCode: async (address) => {
      const code = await withDeadline(watchRpcClient().getCode({ address }), undefined, CODE_DEADLINE_MS);
      return code !== undefined && code !== "0x";
    },
    now: () => new Date(),
    env: process.env,
  }));
}
