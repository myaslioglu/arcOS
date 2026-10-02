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

1. Reads `indexer/mainnet`, the cursor and the console controls (below), and takes the run's lease in the same
   transaction: `runningUntil`, 150 seconds on, and `runId`. A paused or halted indexer stops here, writing nothing. A
   run that finds another run's lease still live skips (it logs `arcosIndexer busy`): one instance at a time doesn't
   rule out an overlap on its own, during a deploy for instance. The first run creates the doc and starts 170,000 blocks
   back (about 24 hours); it never scans from genesis.
2. Takes the `finalized` block as its head. On Arc, `finalized` is `latest` or one block behind, so nothing it reads
   can be reorganised away.
3. Reads the new blocks in windows of at most 10,000 blocks (the RPC's cap), with one `eth_getLogs` per window over
   five contracts: the 4rc.OS TokenFactory (`TokenCreated`), the Uniswap v2 factory (`PairCreated`), the Uniswap v3
   factory (`PoolCreated`), the Uniswap v4 PoolManager (`Initialize`) and the Aerodrome Slipstream factory
   (`PoolCreated`). Calls go at least 400 ms apart, and a rate-limit answer (-32005) is retried with a back-off. A
   window the node refuses as too wide or too full is halved. At most 10 windows a run, none started after 40 seconds,
   and no call or back-off of this phase waited for past 55 seconds: the run then goes on to step 5, and the next run
   reads the window again.
4. Records each pool that has USDC (the `0x3600…` ERC-20, or on v4 native USDC) or EURC on exactly one side, and its
   other side as a token. Every write is keyed by a deterministic id and only adds what is new, so a window read twice
   writes nothing the second time. The tokens (new ones, and known ones queued again for a new pool) are written
   before the pools: a pool doc marks its sighting as done, so a crash between the two leaves the pool to be found
   again. The cursor is written after the window's pools and tokens, and only ever forward: a run that crashes repeats
   a window, and never skips one, and a run behind another never moves the cursor back.
5. Inspects up to `INSPECT_PER_TICK` queued tokens (default 3): a token last found liquid that gained a new pool
   first, then tokens with a pool, then tokens without; newest first within each. A token still queued after 24 hours
   is skipped (it is inspected when someone opens it), and one whose inspection fails three times is skipped too. The
   expiry only reaches the head of the queue (the `INSPECT_PER_TICK` × 4 tokens a run reads), so an old token further
   back stays `queued` until it gets there. The index's Uniswap v4 pools of a token, hooked ones included, go to the
   Inspector as extra pools. Each report is kept 90 days (`reports/`, TTL on `expiresAt`); the token keeps the summary,
   its best pool and Radar's two flags.
6. Brings the four Radar first pages (`radarFeed/mainnet:{all,liquid,passing,liquid-passing}`) up to date with the
   tokens the run changed, and rebuilds one of the four from its query, a different one each minute, writing a page
   only when it changed. A page that missed a change (a run that died between an inspection and this step) is whole
   again within four runs.
7. Ends the run: `lastRunAt`, the day's explorer calls, and the lease given back. Steps 6 and 7 run whatever failed in
   step 5; the error's name is in the run's log line (`error`). A run that halts or fails before step 7 gives the lease
   back too, and a run that died holding it leaves a lease that expires on its own.

The indexer records pools, not their depth: `pools.depthUsdc` and `pools.sampledAt` stay `null` in R1. A token's best
pool and its depth come from its inspection (`tokens.bestPool`).

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
| `block` | a block number | The cursor: the last block fully read. Lowering it makes the next runs read those blocks again (nothing is duplicated). Never raise it past blocks not yet read: they would be skipped. The indexer itself only ever moves it forward. |
| `runningUntil`, `runId` | (set by the indexer) | The lease of the run in progress, `null` between runs. While `runningUntil` is in the future, a new run skips. Leave them alone: a lease left by a run that died expires 150 seconds after it was taken. |

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
files with the sites' bundles, checks the manifest with `jq` (one document; every endpoint named `arcos…`, run as
`arcos-jobs@`, triggered by a schedule and nothing else, in `europe-west4`; no extensions, no lifecycle hooks, no param
or secret but `BLOCKSCOUT_API_KEY`), and only then signs in and hands both to the Firebase CLI, which reads the manifest
instead of loading the code. A manifest that fails the check stops the deploy with a message that says which rule it
broke. On a push, a functions build that fails stops the sites' deploy too (the deploy job waits for every build); to
ship the sites meanwhile, run the workflow by hand with `targets: both`.
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

Once, before `ARCOS_FUNCTIONS_READY` is set. The deployer is `arcos-deployer@arcos-c80cf.iam.gserviceaccount.com`
([DEPLOYING.md](DEPLOYING.md)). Its roles below come from what the pinned Firebase CLI (`tools/firebase`) calls when it
deploys a scheduled 2nd-gen function; the files named are under `tools/firebase/node_modules/firebase-tools/lib`.

1. The database `arcos` exists, with its rules and indexes deployed once (the Firestore foundation's steps).
2. A budget alert on the billing account: `arcos` pays from its first operation.
3. The service account `arcos-jobs@arcos-c80cf.iam.gserviceaccount.com`, with:
   - `roles/datastore.user` on the project, with the IAM condition
     `resource.name=="projects/arcos-c80cf/databases/arcos"`, so it reaches no other database;
   - `roles/logging.logWriter` on the project;
   - `roles/secretmanager.secretAccessor` on the secret `BLOCKSCOUT_API_KEY` (a binding on the secret, not the project).
4. The APIs, enabled by the owner. Before every functions deploy the CLI checks each API it needs and enables one that
   is off (`deploy/functions/prepare.js`); the deployer holds only `roles/serviceusage.serviceUsageConsumer`, which can
   check an API but not enable one, so a missing API stops the deploy:

   ```bash
   gcloud services enable run.googleapis.com eventarc.googleapis.com pubsub.googleapis.com storage.googleapis.com \
     cloudscheduler.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com \
     artifactregistry.googleapis.com cloudfunctions.googleapis.com --project arcos-c80cf
   ```

5. The deployer gains:
   - `roles/cloudfunctions.developer` and `roles/cloudscheduler.admin` on the project: the function and its Scheduler
     job;
   - `roles/iam.serviceAccountUser` on `arcos-jobs@` only: the function and the job run as it;
   - `roles/secretmanager.viewer` on `BLOCKSCOUT_API_KEY`: the CLI resolves the secret's version;
   - `roles/datastore.indexAdmin` on the project, with the same `arcos` condition as above: the indexes;
   - a custom role holding `run.services.getIamPolicy` and `run.services.setIamPolicy`, bound on the project with an IAM
     condition that limits it to the Cloud Run services whose names start with `arcos` (the function's service is
     `arcosindexer`). The CLI lets `arcos-jobs@` invoke the function by writing the `roles/run.invoker` binding on that
     service: a create sets the service's policy (`run.services.setIamPolicy`, `deploy/functions/release/fabricator.js`
     around lines 507-513), and an update reads it and then sets it (`fabricator.js` around lines 625-628,
     `gcp/run.js` lines 130-153). Not `roles/run.admin` on the project: that would let the deployer change every Cloud
     Run service of the other services in the project.

     ```bash
     gcloud iam roles create arcosRunInvokerAdmin --project arcos-c80cf \
       --title "arcos: Cloud Run invoker bindings" \
       --permissions run.services.getIamPolicy,run.services.setIamPolicy --stage GA
     gcloud projects add-iam-policy-binding arcos-c80cf \
       --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" \
       --role projects/arcos-c80cf/roles/arcosRunInvokerAdmin \
       --condition 'expression=resource.name.startsWith("projects/arcos-c80cf/locations/europe-west4/services/arcos"),title=arcos Cloud Run services only'
     ```

     The condition is verified on the first deploy: if that deploy stops at "set invoker" with a permission error on
     `run.services.setIamPolicy`, the resource name Cloud Run checks differs from the one above. Read it from the
     error or the audit log, and fix the condition; never drop it.
   - No Artifact Registry role (see step 6).
6. The cleanup policy of the functions' image repository, set by the owner:

   ```bash
   tools/firebase/node_modules/.bin/firebase functions:artifacts:setpolicy --location europe-west4 --project arcos-c80cf
   ```

   After a deploy, the CLI reads the `gcf-artifacts` repository of `europe-west4` to check its cleanup policy
   (`deploy/functions/release/index.js`, `setupArtifactCleanupPolicies`). The deployer can't read it, so that check
   fails quietly and the deploy goes on; the policy is never set by the deploy. Without it, old images pile up and are
   billed. The repository is created by the first functions build: if the command says it doesn't exist yet, run it
   again right after the first deploy.
7. The repository variable `ARCOS_FUNCTIONS_READY` set to `true`.

To check on the first run: every 2nd-gen functions deploy asks Service Usage to generate the service identities of
Pub/Sub and Eventarc (`services/<service>:generateServiceIdentity`, `deploy/functions/prepare.js` around lines 644-653),
and the deploy stops with "Error generating the service identity" if that call is refused. Google's reference for the
call names no IAM permission, only an OAuth scope, so whether `roles/serviceusage.serviceUsageConsumer` covers it is
known only once it runs. If it doesn't, the error names the missing permission: grant that permission in a custom role,
not `roles/serviceusage.serviceUsageAdmin`, which could enable any API.

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
| Firestore reads | about 30: the controls and the lease 2, the window's pools and tokens about 4, the cursor 1, the queue up to 12, each inspection's pools 1 or 2, the feeds 4, the end of the run 1; plus up to 50 for the feed rebuilt that run | about 3.5 million |
| Firestore writes | about 17: the lease 1, pools and tokens about 4, the cursor 1, each inspection 2, the feeds up to 4, the end of the run 1 | about 0.7 million |
| Function time | a few seconds, plus up to 15 seconds per inspection | inside or near the free tier at the default CPU of a 512 MiB function (the function sets no `cpu` option) |

The first run's 24-hour backfill reads and writes about 6,000 documents once. Firestore single-region prices are about
half of the multi-region $0.06 per 100,000 reads and $0.18 per 100,000 writes, so the indexer's Firestore use is about
$2 a month. The explorer budget covers about 800 inspections a day; at about 2,900 new tokens a day, most reports
are made on RPC only and marked `degraded` unless the budget grows.

## Tests

- `npm test -w @arcos/functions`: the pure parts (windows, the log decoder on real mainnet logs, pool selection, the
  queue, the feeds, the RPC deadline), and a real build of the bundle and its manifest, read back by the pinned
  Firebase CLI and passed through the deploy job's manifest check.
- `npm run test:emulator -w @arcos/functions`: whole runs against fake chains in the Firestore emulator, under the
  `demo-arcos` project id only: the windows, the queue, a crash inside a window, a run whose inspections fail, the feed
  rebuilt in turn, the lease and the cursor that only moves forward.
- `npm run test:live -w @arcos/functions`: three read-only calls to Arc mainnet. Not part of CI.
