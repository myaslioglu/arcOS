/**
 * The functions' own account (design 1.7): roles/datastore.user on the arcos database only (an IAM condition),
 * roles/logging.logWriter, and access to the secrets it reads. Named from the first deploy, because Cloud Scheduler's
 * OIDC account is fixed when the job is created (design 1.3).
 */
export const JOBS_SERVICE_ACCOUNT = "arcos-jobs@arcos-c80cf.iam.gserviceaccount.com";

/**
 * arcosIndexer's schedule and runtime (design 1.3, "Both functions"): every minute, UTC, in the App Hosting region; one
 * instance handling one request, so two runs never overlap; no retry (the next minute's run repeats a failed window);
 * 120 s, with no new window after 40 s.
 */
export const INDEXER_OPTIONS = {
  schedule: "every 1 minutes",
  timeZone: "Etc/UTC",
  region: "europe-west4",
  retryCount: 0,
  maxInstances: 1,
  concurrency: 1,
  memory: "512MiB",
  timeoutSeconds: 120,
  serviceAccount: JOBS_SERVICE_ACCOUNT,
} as const;

/** The network the indexer reads: Firestore data is mainnet-only (D6), and testnet has no data routes. */
export const INDEXER_NETWORK = "mainnet" as const;

/** The defaults of design 1.8: three inspections a run, 5,000 explorer calls a UTC day. */
export const DEFAULT_SETTINGS = { inspectPerTick: 3, explorerDailyBudget: 5_000 } as const;

/**
 * INSPECT_PER_TICK and EXPLORER_DAILY_BUDGET, from the function's environment, else the defaults. They are plain
 * environment variables rather than firebase-functions params: a param without a value in a dotenv file stops a
 * non-interactive deploy, and the repository keeps no .env file. Nothing sets them today, so the defaults apply; a value
 * that isn't a whole number from 0 to 1,000,000 is ignored.
 */
export function indexerSettings(env: Readonly<Record<string, string | undefined>>): { inspectPerTick: number; explorerDailyBudget: number } {
  const read = (name: string, fallback: number) => {
    const text = env[name]?.trim();
    const value = text && /^\d{1,7}$/.test(text) ? Number(text) : NaN;
    return Number.isSafeInteger(value) && value <= 1_000_000 ? value : fallback;
  };
  return {
    inspectPerTick: read("INSPECT_PER_TICK", DEFAULT_SETTINGS.inspectPerTick),
    explorerDailyBudget: read("EXPLORER_DAILY_BUDGET", DEFAULT_SETTINGS.explorerDailyBudget),
  };
}

/** The RPC endpoint the indexer's eth_getLogs goes to: the one its caps were measured on (F5-F7). */
export const INDEXER_RPC_URL = "https://rpc.mainnet.arc.io";
