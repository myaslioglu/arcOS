# Operations

What runs where, what the owner can switch in the console, how the jobs deploy, what they cost, and how to check them.
Deploying the sites themselves is in [DEPLOYING.md](DEPLOYING.md).

## What runs where

All of it is in the Firebase project `arcos-c80cf`, region `europe-west4`.

| Piece | Runs as | Reads | Writes |
|---|---|---|---|
| App Hosting `arcos`: https://4rcos.com | `arcos-web@` | Arc mainnet RPC, Blockscout PRO API, Firestore `arcos` (pools) | nothing in Firestore yet |
| App Hosting `arcos-testnet`: https://testnet.4rcos.com | `arcos-testnet-web@` | Arc testnet RPC and explorer | nothing; it has no Firestore access |
| Function `arcosIndexer` (codebase `arcos`, [functions/](../functions)) | `arcos-jobs@` | Arc mainnet RPC, Blockscout PRO API | Firestore `arcos`: `indexer`, `pools`, `tokens`, `reports`, `radarFeed` |
| Cloud Scheduler job of `arcosIndexer`, every minute (UTC) | calls the function with an OIDC token of `arcos-jobs@` | | |
| Firestore database `arcos` (Native, `europe-west4`) | | | |

The Firestore data is mainnet data only. The testnet site has no index: `GET /api/pools/[token]` answers 404 there, and
the Inspector reads that as "no indexed pools".

## The indexer

`arcosIndexer` runs once a minute: one instance, one run at a time, no retry, at most 120 seconds. One run:

1. Reads `indexer/mainnet`, the cursor and the console controls (below). A paused or halted indexer stops here. The
   first run creates the doc and starts 170,000 blocks back (about 24 hours); it never scans from genesis.
2. Takes the `finalized` block as its head. On Arc, `finalized` is `latest` or one block behind, so nothing it reads
   can be reorganised away.
3. Reads the new blocks in windows of at most 10,000 blocks (the RPC's cap), with one `eth_getLogs` per window over
   five contracts: the 4rc.OS TokenFactory (`TokenCreated`), the Uniswap v2 factory (`PairCreated`), the Uniswap v3
   factory (`PoolCreated`), the Uniswap v4 PoolManager (`Initialize`) and the Aerodrome Slipstream factory
   (`PoolCreated`). Calls go at least 400 ms apart, and a rate-limit answer (-32005) is retried with a back-off. A
   window the node refuses as too wide or too full is halved. At most 10 windows a run, and none started after 40
   seconds.
4. Records each pool that has USDC (the `0x3600…` ERC-20, or on v4 native USDC) or EURC on exactly one side, and its
   other side as a token. Every write is keyed by a deterministic id and only adds what is new, so a window read twice
   writes nothing the second time. The cursor is written after the window's pools and tokens: a run that crashes
   repeats a window, and never skips one.
5. Inspects up to `INSPECT_PER_TICK` queued tokens (default 3): a token last found liquid that gained a new pool
   first, then tokens with a pool, then tokens without; newest first within each. A token still queued after 24 hours
   is skipped (it is inspected when someone opens it), and one whose inspection fails three times is skipped too. The
   index's Uniswap v4 pools of a token, hooked ones included, go to the Inspector as extra pools. Each report is kept
   90 days (`reports/`, TTL on `expiresAt`); the token keeps the summary, its best pool and Radar's two flags.
6. Rewrites the four Radar first pages (`radarFeed/mainnet:{all,liquid,passing,liquid-passing}`) when anything changed.

Explorer calls count against `EXPLORER_DAILY_BUDGET` (default 5,000 a UTC day, kept in `indexer/mainnet`
`explorerCalls`). Over budget, an inspection runs on RPC only and its report is marked `degraded`.

`INSPECT_PER_TICK` and `EXPLORER_DAILY_BUDGET` are environment variables of the function. Nothing sets them, so the
defaults in [functions/src/indexer/schedule.ts](../functions/src/indexer/schedule.ts) apply; change a default there and
deploy to change it.

### The console controls

In the Firebase console, Firestore, database `arcos`, collection `indexer`, document `mainnet`:

| Field | Set to | Effect |
|---|---|---|
| `paused` | `true` | The next run stops at once: no RPC call, no write. Set it back to `false` to resume where the cursor is. |
| `inspect` | `false` | New tokens are recorded as `skipped` instead of queued, and no inspection runs. Pools, tokens and the cursor still move. |
| `halted` | (set by the indexer) | The indexer stopped itself, and says why: the node refused even a one-block window, or refused 24 windows in one run. Read the reason, fix the cause, then set the field to `null`. |
| `block` | a block number | The cursor: the last block fully read. Lowering it makes the next runs read those blocks again (nothing is duplicated). Never raise it past blocks not yet read: they would be skipped. |

The indexer never writes `paused` or `inspect`. Change them only between runs (any time is fine: the next run reads them).

## The site's reads

- `GET /api/pools/[token]` answers the token's indexed pools, v4 pool keys included, kept 60 seconds at the CDN.
- `/api/inspect`, `/t` and `/badge` pass the index's v4 pools to the Inspector, and the Inspector window reads them from
  `/api/pools`. This is how a v4 pool with a hook, or with a fee outside the five standard tiers, gets inspected.
- The site reads the index only on mainnet, and only on App Hosting (or against the emulator), so a dev server never
  reaches the live database. A read gets 1.5 seconds; after a failure the site reads nothing for a minute. Without the
  index, every inspection runs as before, on its own pool discovery.

## Deploying

With the repository variable `ARCOS_FUNCTIONS_READY` set to `true`, every push to `main` deploys, after the sites and
under the same approval, the Firestore indexes (`firebase deploy --only firestore:indexes`) and then the functions
(`firebase deploy --only functions:arcos`). A manual run can deploy either alone: Actions, Deploy, Run workflow, with
`targets: indexes` or `targets: functions`. The rules (`firestore/arcos.rules`) are not deployed by the workflow.

The functions are built in a job without a credential: `npm run build -w @arcos/functions` bundles
[functions/src](../functions/src) with esbuild into `functions/deploy/index.js` and writes
`functions/deploy/functions.yaml`, the manifest firebase-functions makes from that bundle. The deploy job scans both
files with the sites' bundles and hands them to the Firebase CLI, which reads the manifest instead of loading the code.
Cloud Build installs `firebase-admin` and `firebase-functions` from `functions/deploy/package-lock.json`, with install
scripts off (`functions/deploy/.npmrc`). The built files are never committed.

Every function of this codebase has a name that starts with `arcos`: the CLI assigns a deployed function to a codebase by
its name first, so a shared name would take over another codebase's function. A unit test in `@arcos/data` pins it.

By hand, from a clean checkout of `main`, the same deploy is:

```bash
npm ci
npm run build -w @arcos/functions
npm ci --ignore-scripts --prefix tools/firebase
tools/firebase/node_modules/.bin/firebase deploy --only firestore:indexes --project arcos-c80cf
tools/firebase/node_modules/.bin/firebase deploy --only functions:arcos --project arcos-c80cf
```

The function's secret, `BLOCKSCOUT_API_KEY`, is pinned to the version the deploy resolves: rotating it means deploying
again.

## Setting it up

Once, before `ARCOS_FUNCTIONS_READY` is set:

1. The database `arcos` exists, with its rules and indexes deployed once (the Firestore foundation's steps).
2. A budget alert on the billing account: `arcos` pays from its first operation.
3. The service account `arcos-jobs@arcos-c80cf.iam.gserviceaccount.com`, with:
   - `roles/datastore.user` on the project, with the IAM condition
     `resource.name=="projects/arcos-c80cf/databases/arcos"`, so it reaches no other database;
   - `roles/logging.logWriter` on the project;
   - `roles/secretmanager.secretAccessor` on the secret `BLOCKSCOUT_API_KEY` (a binding on the secret, not the project).
4. The deploy account gains: `roles/cloudfunctions.developer` and `roles/cloudscheduler.admin` on the project;
   `roles/iam.serviceAccountUser` on `arcos-jobs@` only; `roles/secretmanager.viewer` on `BLOCKSCOUT_API_KEY`; and
   `roles/datastore.indexAdmin` on the project with the same `arcos` condition.
5. The repository variable `ARCOS_FUNCTIONS_READY` set to `true`.

If the first functions deploy stops with a permission error, the message names the missing permission. Two are
possible beyond the list above: `run.services.setIamPolicy`, which the CLI uses to let `arcos-jobs@` invoke the function's
Cloud Run service (`roles/run.admin` on the project grants it), and `artifactregistry.repositories.get` on the
`gcf-artifacts` repository of `europe-west4`, which the CLI reads to check its cleanup policy. Without a cleanup policy
there, a non-interactive deploy fails after deploying; set one once with
`firebase functions:artifacts:setpolicy --location europe-west4 --project arcos-c80cf`.

After the first deploy, check the Scheduler job (below): its OIDC account must be `arcos-jobs@`. It is fixed when the job
is created, and changing the function's account later doesn't move it.

## Checking it

The Scheduler job and the account it calls with:

```bash
gcloud scheduler jobs list --location europe-west4 --project arcos-c80cf
gcloud scheduler jobs describe firebase-schedule-arcosIndexer-europe-west4 --location europe-west4 --project arcos-c80cf \
  --format='value(schedule,timeZone,state,httpTarget.oidcToken.serviceAccountEmail)'
```

Expected: `every 1 minutes`, `Etc/UTC`, `ENABLED`, `arcos-jobs@arcos-c80cf.iam.gserviceaccount.com`.

The runs, in Logs Explorer:

```
resource.type="cloud_run_revision" resource.labels.service_name="arcosindexer" jsonPayload.message=~"^arcosIndexer"
```

Each run logs one line: `arcosIndexer run` with `from`, `to`, `windows`, `pools`, `tokens`, `inspected`, `failed`,
`expired`, `feeds` and `explorerCalls`; a halted indexer logs `arcosIndexer halted` with its reason. No line carries an
address. In Firestore, `indexer/mainnet` shows the cursor (`block`), `lastRunAt` and the day's explorer calls.

## What it costs

At the rate measured on 2026-10-02 (a 10,000-block window, about 84 minutes, held 170 qualifying pools: about two a
minute), a steady-state run makes:

| | Per run | Per month (43,200 runs) |
|---|---|---|
| Arc RPC (indexer) | 2 calls: the head and one window | about 86,000 |
| Arc RPC (inspections) | about 15 to 40 `eth_call`s per inspection, up to 3 inspections | about 2 to 5 million |
| Blockscout PRO | up to about 6 per inspection | at most 5,000 a day (the budget), about 150,000 |
| Firestore reads | about 25: the controls 1, the window's pools and tokens about 4, the queue up to 12, each inspection's pools 1 or 2, the feeds 4 | about 1.1 million |
| Firestore writes | about 16: pools and tokens about 4, the cursor 1, each inspection 2, the feeds 4, the end of the run 1 | about 0.7 million |
| Function time | a few seconds, plus up to 15 seconds per inspection | inside or near the free tier at the default CPU of a 512 MiB function |

The first run's 24-hour backfill reads and writes about 6,000 documents once. Firestore single-region prices are about
half of the multi-region $0.06 per 100,000 reads and $0.18 per 100,000 writes, so the indexer's Firestore use is about
$1 to $2 a month. The explorer budget covers about 800 inspections a day; at about 2,900 new tokens a day, most reports
are made on RPC only and marked `degraded` unless the budget grows.

## Tests

- `npm test -w @arcos/functions`: the pure parts (windows, the log decoder on real mainnet logs, pool selection, the
  queue, the feeds), and a real build of the bundle and its manifest, read back by the pinned Firebase CLI.
- `npm run test:emulator -w @arcos/functions`: whole runs against fake chains in the Firestore emulator, under the
  `demo-arcos` project id only.
- `npm run test:live -w @arcos/functions`: three read-only calls to Arc mainnet. Not part of CI.
