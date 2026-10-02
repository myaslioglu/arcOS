// The functions codebase `arcos` (firebase.json). esbuild bundles this file into functions/deploy/index.js. Every
// export is a function, and every function's name starts with arcos: firebase-tools assigns a deployed function to a
// codebase by its name first, so a name another codebase uses would take that function over (design 1.3). A unit test
// in @arcos/data reads the names exported here.
import * as logger from "firebase-functions/logger";
import { defineInt, defineSecret } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/scheduler";
import { arcosDb } from "@arcos/data/server";
import { liveInspector } from "./indexer/inspect";
import { rpcLogChain } from "./indexer/rpc";
import { runIndexer } from "./indexer/run";
import { INDEXER_NETWORK, INDEXER_OPTIONS, INDEXER_RPC_URL } from "./indexer/schedule";

/** The Blockscout PRO key, the site's own secret. A deploy pins the version it resolves. */
const blockscoutApiKey = defineSecret("BLOCKSCOUT_API_KEY");
const inspectPerTick = defineInt("INSPECT_PER_TICK", { default: 3, description: "Tokens arcosIndexer inspects per run" });
const explorerDailyBudget = defineInt("EXPLORER_DAILY_BUDGET", { default: 5000, description: "Explorer calls arcosIndexer may make per UTC day" });

// One inspector per instance, so its RPC cooldowns carry from one run to the next.
let inspector: ReturnType<typeof liveInspector> | undefined;

export const arcosIndexer = onSchedule({ ...INDEXER_OPTIONS, secrets: [blockscoutApiKey] }, async () => {
  inspector ??= liveInspector({ network: INDEXER_NETWORK, apiKey: blockscoutApiKey.value() });
  const result = await runIndexer({
    db: arcosDb(),
    network: INDEXER_NETWORK,
    chain: rpcLogChain(INDEXER_RPC_URL),
    inspectToken: inspector,
    settings: { inspectPerTick: inspectPerTick.value(), explorerDailyBudget: explorerDailyBudget.value() },
    log: logger,
  });
  if (result.status === "halted") logger.error("arcosIndexer halted", result);
  else logger.info("arcosIndexer run", result);
});
