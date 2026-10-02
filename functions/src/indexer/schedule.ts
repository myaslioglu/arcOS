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

/** The RPC endpoint the indexer's eth_getLogs goes to: the one its caps were measured on (F5-F7). */
export const INDEXER_RPC_URL = "https://rpc.mainnet.arc.io";
