# Operations

What runs where, what the owner can switch in the console, how the jobs deploy, what they cost, and how to check them.
Deploying the sites themselves is in [DEPLOYING.md](DEPLOYING.md).

## What runs where

All of it is in the Firebase project `arcos-c80cf`, region `europe-west4`.

| Piece | Runs as | Reads | Writes |
|---|---|---|---|
| App Hosting `arcos`: https://4rcos.com | `arcos-web@` | Arc mainnet RPC, Blockscout PRO API, Firestore `arcos` (pools, radarFeed, indexer) | nothing in Firestore yet |
| App Hosting `arcos-testnet`: https://testnet.4rcos.com | `arcos-testnet-web@` | Arc testnet RPC and explorer | nothing; it has no Firestore access |
| Function `arcosIndexer` (codebase `arcos`, [functions/](../functions)) | `arcos-jobs@` | Arc mainnet RPC, Blockscout PRO API, the Telegram Bot API (sends only), Firestore `arcos` (`watches`, `users`) | Firestore `arcos`: `indexer`, `pools`, `tokens`, `reports`, `radarFeed`, `watchState`, `alerts`, `deliveries`, `users.telegram` (cleared when a chat blocked the bot) |
| Cloud Scheduler job of `arcosIndexer`, every minute (UTC) | calls the function with an OIDC token of `arcos-jobs@` | | |
| Firestore database `arcos` (Native, `europe-west4`) | | | |

The Firestore data is mainnet data only. The testnet site has no index: `GET /api/pools/[token]` answers 404 there, and
the Inspector reads that as "no indexed pools".

`GET /api/radar` reads one radarFeed doc and `indexer/mainnet` in one `getAll` (2 reads), keeps the answer 15 s per filter
in each instance and 20 s at the CDN, with its own 1.5 s deadline and 60 s cooldown. It answers 404 on testnet. Logs:
`radar failed <name> [<gRPC code>]`, and `radar rows skipped <n>` if a stored row is malformed. The site's
`roles/datastore.user` on the `arcos` database covers both reads, so there is no IAM change.

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
   a window, and never skips one, and a run behind another never moves the cursor back. New pools and tokens are
   created, never overwritten: if another run created one in the meantime, the window is read and written once more,
   and that doc is left as it is.
4b. Watchdog (below): checks a page of watched tokens at the run's head, writes each change with its alerts, fans the
   alerts out to deliveries and sends the oldest pending ones to Telegram, each phase within its own time limit.
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
7. Ends the run: `lastRunAt` (never moved back), the run's explorer calls added to the day's count, Watchdog's page
   cursor (`watchCursor`) when the step ran, and the lease given back if it is still this run's.

Once the window phase (steps 2 to 4) is over, steps 5, 6 and 7 run whatever fails in step 4b, steps 6 and 7 run
whatever fails in step 5, and a failure in step 6 doesn't stop step 7; the error's name is in the run's log line
(`error`), with its `code` when it has one, and, for a Firestore error, its `details` with URLs and addresses masked,
cut to 200 characters (never the message, which could carry a node's URL). Before that, they don't: a run that can't read the head, halts, or fails to write a window's pools,
tokens or cursor ends there, with no feed update and no `lastRunAt`. It has spent no explorer call yet, so the day's
count loses nothing, and the next run reads the window again. Such a run gives the lease back on its way out (best
effort), and a run that died holding it leaves a lease that expires on its own.

The indexer records pools, not their depth: `pools.depthUsdc` and `pools.sampledAt` stay `null` in R1. A token's best
pool and its depth come from its inspection (`tokens.bestPool`).

Explorer calls count against `EXPLORER_DAILY_BUDGET` (default 3,000 a UTC day, kept in `indexer/mainnet`
`explorerCalls`). Over budget, an inspection runs on RPC only and its report is marked `degraded`. The website reads
Blockscout's PRO API with the same key (Revoke's approvals, the Inspector pages), so the budget must leave it headroom
under the plan's own daily quota: on 2026-10-02 a 5,000 budget was the whole plan, the indexer spent it by
mid-afternoon, and every `/api/approvals` lookup on the site answered 503 until the UTC day ended. The explorer's own
refusals are read too: after a 429 the indexer sends no explorer request for 60 s; after a 402 (the plan's quota or its
payment is gone) it also marks the rest of the day's budget spent, so no run today asks again. Signs of a spent plan,
in Logs Explorer: `approvals failed ApprovalsUnavailable 402` on the site's service (`arcos`); on the indexer's side,
`explorerCalls.count` at the budget in `indexer/mainnet` and new `reports` docs with `degraded: true` (an explorer
refusal degrades a report, it doesn't fail the inspection). The site's own calls are not counted there, so check the
plan's dashboard for the day's total.

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
| `watch` | `false` | Stops the whole Watchdog step (no check, no fan-out, no send). A missing field reads as `true`. |
| `telegram` | `false` | Stops Watchdog's Telegram sends only: the checks still run, alerts and deliveries are still written, and the deliveries wait as `pending` (they expire after a day). A missing field reads as `true`. |
| `watchCursor` | (set by the indexer) | The `watchState` doc id Watchdog's checks ended at; the next run's page starts after it. Set it to `null` to start the round from the first token. |

The indexer never writes `paused`, `inspect`, `watch` or `telegram`. Change them only between runs (any time is fine: the
next run reads them).

## Watchdog

The Watchdog step (step 4b of a run; design 3.4) runs on mainnet only, inside `arcosIndexer`: no second function, no
second schedule. A wallet's watches are `watches/{user}:{network}:{token}` docs, and each watched token has one
`watchState/{network}:{token}` doc with the last state observed and its watcher count (the site's routes write both, in
one transaction per change). One run:

- **A. The checks.** Reads the next page of up to 40 `watchState` docs after `watchCursor`, in doc id order, wrapping to
  the start (so each of N watched tokens is checked every ceil(N / 40) minutes), then the `tokens` and `pools` docs of
  the page in two `getAll`s. Each token takes 3 RPC requests, pinned to the run's finalized head and each cut off after
  5 s: one `aggregate3` through Multicall3 for `owner()`/`getOwner()`, `totalSupply()`, `paused()`, `symbol()`,
  `decimals()` and the deepest pool's depth (a v2 pair's quote reserve, a v3 or Aerodrome pool's quote balance, or a v4
  pool's `getSlot0` and `getLiquidity` priced in range), and two `eth_getStorageAt` for the EIP-1967 and ZeppelinOS
  implementation slots. Four tokens are in flight at a time. Watch reads go through their own RPC client with their own
  endpoint health, never through the Inspector or the explorer, so `explorerCalls` never move. A read that fails
  (transport, timeout, a rejected aggregate, a malformed slot word) leaves its fields *unread*: the stored values are
  kept and nothing alerts. A token's first check stores its state and alerts nothing; a later check compares the
  observation with the stored state ([packages/data/src/watch.ts](../packages/data/src/watch.ts): owner changed, supply
  increased, paused, unpaused, implementation changed, the deepest pool's depth down at least 30% and 500 units) and
  writes the state change **and its alert docs in one batch**, so a crash keeps both or neither; the doc is only written
  on change. After 3 consecutive transport or timeout failures the run's remaining reads stop (the endpoints are down,
  not the token). A `watchState` doc deleted mid-run (its last watcher left) is skipped.
- **B. The fan-out.** For up to 10 alerts with `fannedOut: false`, creates one `deliveries/{alert}:{user}:telegram`
  doc per watcher whose `users` doc has a Telegram chat, `pending`, paging the token's watches 400 at a time; at most
  1,000 creates a run. The ids are deterministic and only missing docs are created, so a fan-out that stopped (the
  budget, the time limit, a crash) resumes next run without a second delivery, and `fannedOut` becomes `true` only
  after the last page.
- **C. The sends.** Reads the 100 oldest `pending` deliveries with their `users` and `alerts`. One older than a day is
  failed as `expired`, one whose wallet has no chat any more as `unlinked`, one whose alert is gone as `no_alert`. The
  rest go to the Bot API's `sendMessage`, plain text (no parse mode, no link preview), `<words> — <explorer link>`,
  the words naming the token as `SYMBOL (0x1234…abcd)` when the symbol is plain, else as the short address alone. A
  symbol is plain when it holds nothing but letters, digits, spaces, `_` and `-`, holds at least one letter, and holds
  no run of seven or more digits (one space, `_` or `-` between two digits doesn't break the run): Telegram makes a
  URL, a domain, an `@mention`, a `/command` or a phone number tappable even in plain text. Then 4 s per send, 4 chats
  at a time, each chat's sends in order, at most 3 per chat and 60 in all per run. Send first, then mark (at least once, never lost). A delivery is `sent` on 200; on a 5xx, a timeout or a network failure it stays
  `pending` with the attempt counted and is tried again on later runs, `failed` after 4 attempts in all; a 403 (the
  chat blocked the bot) or "chat not found" fails it at once and clears the wallet's chat (if it is still that chat);
  any other 400 fails it. A 429 stops this instance's sends for the seconds Telegram asks (1 s to 1 h); a 401 or 404
  (the token is wrong or revoked) stops them for 10 minutes; neither counts an attempt.

Time limits, on the run's clock: the step starts only before 55 s; no read starts after 62 s (so the reads end by 67 s);
no fan-out page starts after 68 s; no send starts after 72 s (so the sends end by 76 s). Inspections still start before
80 s as before, so Watchdog never moves the run's end; at worst it narrows the window in which inspections may start.
Typically it takes a few seconds. Work the limits cut short resumes next minute: the cursor covers only the tokens
attempted, `fannedOut` stays `false`, deliveries stay `pending`.

The bot token is the function's secret `TELEGRAM_BOT_TOKEN`, read inside the function and nowhere else (the site never
calls the Bot API). A value that isn't a token (empty, `none`) leaves the sends off: the instance logs
`arcosIndexer telegram not configured` once, the checks and the fan-out still run, and the deliveries wait. The secret
is pinned to the version the deploy resolves: to rotate it or replace a wrong value, add a new version (the commands
are under Setting it up, step 3), deploy the functions again, and destroy the old version only after that deploy (the
running revision is pinned to it until then). The webhook is registered once the site's `/api/telegram/webhook` route
is live (Watchdog part 3); until then rotating the bot token needs no webhook step.

Logs, all under `arcosIndexer`, with names, codes and counts only (never an address, a chat id, a token, a message or a
URL):

| Line | Fields | Meaning |
|---|---|---|
| `arcosIndexer run` | `watch: {checked, unread, failed, alerts, writes, deliveriesCreated, fannedOut, sent, sendFailed, skipped}` | The step's counters; `watch: null` when the step didn't run. `skipped` is `off` (the switch) or `late` (the run reached 55 s before the step). The page cursor is left out of the line (it is a `watchState` doc id, which names a token); read it in Firestore, `indexer/mainnet.watchCursor`. |
| `arcosIndexer watch read failed` | `code`: `timeout`, `transport` or `reverted` | One token's read failed; its fields stay as stored. At most 5 a run, then `{suppressed: true}`. |
| `arcosIndexer watch reads stopped` | `code: breaker` | 3 consecutive transport or timeout failures: the run's remaining reads were skipped. |
| `arcosIndexer watch check failed` | `error`, `code`, `details` (masked) | A token's Firestore read or write failed; it is read again on its next turn. At most 5 a run. |
| `arcosIndexer telegram send failed` | `code` (the delivery's error code), `status` (a 5xx), `attempts` | One send failed. At most 5 a run. |
| `arcosIndexer telegram paused` | `code`: `rate_limited` or `unauthorized`; `seconds` | This instance makes no send for `seconds`. |
| `arcosIndexer telegram not configured` | | The secret holds no token; sends are off on this instance. |
| `arcosIndexer watch stopped` | `phase`: `checks`, `fanout` or `sends`; `error`, `code` | The phase failed on the Firestore side; the run went on to its inspections, with the error named in the run line. A `fanout` or `sends` failure keeps the checks' counters, their cursor and the fan-out's counters in the run line and the cursor in `indexer/mainnet`; a `checks` failure leaves `watch: null` and the cursor as it was. |

Signs to look for: `unread` close to `checked` for many runs (the RPC endpoints are refusing the reads; the breaker
line says so), `sendFailed` with `code: telegram_5xx` (Telegram's side), `arcosIndexer telegram paused` with
`unauthorized` (the token was revoked or the secret holds the wrong value: add a new version, as under Setting it up,
step 3, and deploy), and
`deliveries` docs expiring (`error: expired`) while `telegram` is `true` (sends were paused or failing for a day).

## The site's reads

- `GET /api/pools/[token]` answers the token's indexed pools, v4 pool keys included, kept 60 seconds at the CDN.
- `GET /api/radar` answers the first Radar page of a filter (the newest 50 tokens, each with Inspector's counts), kept 20
  seconds at the CDN; the Radar window polls it every 20 seconds.
- `/api/inspect`, `/t` and `/badge` pass the index's v4 pools to the Inspector, and the Inspector window reads them from
  `/api/pools`. This is how a v4 pool with a hook, or with a fee outside the five standard tiers, gets inspected.
- The site reads the index only on mainnet, and only on App Hosting (or against the emulator), so a dev server never
  reaches the live database. A read gets 1.5 seconds; after a failure the site reads nothing for a minute. Without the
  index, every inspection runs as before, on its own pool discovery.

## Deploying

With the repository variable `ARCOS_FUNCTIONS_READY` set to `true`, every push to `main` deploys, after the sites and
under the same approval, the functions (`firebase deploy --only functions:arcos`). A manual run can deploy them alone:
Actions, Deploy, Run workflow, with `targets: functions`. `--only functions:arcos` keeps the CLI's functions target
alone (`filterTargets.js`), so the deploy never reads or writes Firestore: only a Firestore-triggered function would
make it look up a database, and the manifest check below allows a schedule only.

The workflow deploys neither the Firestore indexes (`firestore/arcos.indexes.json`) nor the rules
(`firestore/arcos.rules`). The owner deploys both by hand, from a clean checkout of `main`, as in the Firestore
foundation's steps:

```bash
npm ci --ignore-scripts --prefix tools/firebase
tools/firebase/node_modules/.bin/firebase deploy --only firestore:arcos --project arcos-c80cf
```

The reason is the pinned CLI: even with `--only firestore:indexes`, its Firestore deploy adds the rules file and
compiles it through the Rules API (`firebaserules.googleapis.com/.../projects/arcos-c80cf:test`,
`deploy/firestore/prepare.js`; `--only` decides only whether the rules are released). The deployer has no rules
permission, on purpose, so every indexes deploy from the workflow failed with a 403 there, and the functions deploy
after it never ran. Deploy the indexes after a change to `firestore/arcos.indexes.json`, before the code that needs
them; without `--force` an index the file no longer names is left in place, never deleted.

The functions are built in a job without a credential: `npm run build -w @arcos/functions` bundles
[functions/src](../functions/src) with esbuild into `functions/deploy/index.js` and writes
`functions/deploy/functions.yaml`, the manifest firebase-functions makes from that bundle. The deploy job scans both
files with the sites' bundles, checks the manifest with `jq` (one document; the one endpoint `arcosIndexer`, `gcfv2`,
run as `arcos-jobs@`, triggered by a schedule and nothing else, in `europe-west4`, with no VPC, no environment variables
and the default ingress; no extensions, no lifecycle hooks, no required roles; required APIs only from the pinned CLI's
standard list; no param or secret but the two `FUNCTIONS_SECRETS` names, `BLOCKSCOUT_API_KEY` and
`TELEGRAM_BOT_TOKEN`), and only then signs in and hands both to the Firebase CLI, which reads the manifest instead of
loading the code. A manifest that fails the check stops the deploy with a message that says which rule it
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
tools/firebase/node_modules/.bin/firebase deploy --only functions:arcos --project arcos-c80cf
```

The function's secrets, `BLOCKSCOUT_API_KEY` and `TELEGRAM_BOT_TOKEN`, are pinned to the versions the deploy resolves:
rotating either means deploying again. Both must exist, with the bindings of steps 3 and 5 below, before a deploy of a
function that declares them: a deploy whose pinned secret is missing fails. In a run of the deploy workflow the sites'
App Hosting rollouts come before the functions deploy, so such a failure lands after the sites have shipped; the secret
and its bindings come before the merge that deploys the function.

## Setting it up

Once, before the first functions deploy. The deploy workflow refuses `targets: functions` until the repository
variable `ARCOS_FUNCTIONS_READY` is `true`, so the variable is set (step 7) before that deploy (step 8). The deployer is
`arcos-deployer@arcos-c80cf.iam.gserviceaccount.com` ([DEPLOYING.md](DEPLOYING.md)). Its roles below come from what the
pinned Firebase CLI (`tools/firebase`) calls when it deploys a scheduled 2nd-gen function, and from what the first
functions deploy (2026-10-02) was refused; the files named are under `tools/firebase/node_modules/firebase-tools/lib`.
The deployer doesn't hold `roles/editor`: the owner granted it for a while to get the first deploy through, then
removed it, and every later deploy must work with the roles below alone.

1. The database `arcos` exists, with its rules and indexes deployed once (the Firestore foundation's steps).
2. A budget alert on the billing account: `arcos` pays from its first operation.
3. The service account `arcos-jobs@arcos-c80cf.iam.gserviceaccount.com`, with:
   - `roles/datastore.user` on the project, with the IAM condition
     `resource.name=="projects/arcos-c80cf/databases/arcos"`, so it reaches no other database;
   - `roles/logging.logWriter` on the project;
   - `roles/secretmanager.secretAccessor` on the secret `BLOCKSCOUT_API_KEY`, and on the secret `TELEGRAM_BOT_TOKEN`
     (Watchdog's bot token; a binding on each secret, not the project).

   To see them (each should list `arcos-jobs@` under `roles/secretmanager.secretAccessor`):

   ```bash
   gcloud secrets get-iam-policy BLOCKSCOUT_API_KEY --project arcos-c80cf
   gcloud secrets get-iam-policy TELEGRAM_BOT_TOKEN --project arcos-c80cf
   ```

   The bot token's secret is created by the owner before the first deploy that declares it (the owner pastes the token
   at a silent prompt; it is printed nowhere), with the same replication policy as `BLOCKSCOUT_API_KEY`, and the
   binding added with:

   ```bash
   read -rsp 'Bot token: ' T; echo; printf %s "$T" | gcloud secrets create TELEGRAM_BOT_TOKEN --project arcos-c80cf \
     --data-file=- --replication-policy=automatic; unset T
   gcloud secrets add-iam-policy-binding TELEGRAM_BOT_TOKEN --project arcos-c80cf \
     --member "serviceAccount:arcos-jobs@arcos-c80cf.iam.gserviceaccount.com" --role roles/secretmanager.secretAccessor
   ```

   A wrong value (a token pasted wrong, a token rotated at BotFather) is replaced with a new version, which keeps the
   secret and its bindings; `gcloud secrets create` would only answer `ALREADY_EXISTS`. The order matters once a
   deploy has pinned the secret: the deployed `arcosIndexer` revision is pinned to the old version, and a Cloud Run
   instance resolves its secret when it starts, so destroying a version a deployed function is pinned to stops every
   new instance of that function (the whole schedule, pools, tokens and feeds included, not only the sends) until the
   next deploy lands, which needs a merge and the owner's OK. So: add the new version, deploy the functions again (the
   deploy pins the latest version), and destroy the old version only then.

   First the new version:

   ```bash
   read -rsp 'Bot token: ' T; echo; printf %s "$T" | gcloud secrets versions add TELEGRAM_BOT_TOKEN --project arcos-c80cf \
     --data-file=-; unset T
   gcloud secrets versions list TELEGRAM_BOT_TOKEN --project arcos-c80cf
   ```

   Then the functions deploy (Deploying, above). Once the new revision is serving, the old version is destroyed, so
   no deploy can resolve it again:

   ```bash
   gcloud secrets versions destroy 1 --secret TELEGRAM_BOT_TOKEN --project arcos-c80cf
   ```

   (`1` being the wrong version's number in the list. `functions:secrets:prune` is no substitute: it lists only the
   secrets the Firebase CLI created itself, labelled `firebase-managed=true`. `gcloud secrets create` adds no label and
   the deploy adds none later, so for this secret prune reports "All secrets are in use. Nothing to prune today." and
   leaves the wrong version enabled; the `gcloud secrets versions destroy` above is the command that works.)
   Before any deploy has pinned the secret, the destroy can follow the add at once, since no function reads the old
   version. Deleting the secret and creating it again also works before any deploy has pinned it, but it drops the
   secret's bindings, so this binding and step 5's (the deployer's) are then added again, and
   `gcloud secrets get-iam-policy TELEGRAM_BOT_TOKEN --project arcos-c80cf` should list both members before the next
   deploy:

   ```bash
   gcloud secrets delete TELEGRAM_BOT_TOKEN --project arcos-c80cf --quiet
   ```

   Both ways run in [Cloud Shell](https://shell.cloud.google.com/?project=arcos-c80cf).

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
   - `roles/iam.serviceAccountUser` on the App Engine default account `arcos-c80cf@appspot.gserviceaccount.com` only.
     Before any functions deploy, `commands/deploy.js` runs `checkServiceAccountIam`
     (`deploy/functions/checkIam.js`), which stops the deploy unless the deployer has `iam.serviceAccounts.actAs` on
     that account, whatever account the function runs as. It is safe: the deploy job's manifest check (Deploying,
     above) stops any manifest whose function runs as an account other than `arcos-jobs@`, so the workflow never
     deploys a function that runs as the default account.

     ```bash
     gcloud iam service-accounts add-iam-policy-binding arcos-c80cf@appspot.gserviceaccount.com --project arcos-c80cf \
       --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" --role roles/iam.serviceAccountUser
     ```

   - `roles/iam.serviceAccountUser` on the project's default Compute account
     `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` only. Cloud Functions 2nd gen builds the function with
     that account, so every functions deploy needs `iam.serviceAccounts.actAs` on it. The
     production deploy without it stopped with "Caller is missing permission 'iam.serviceaccounts.actAs' on service
     account projects/-/serviceAccounts/<PROJECT_NUMBER>-compute@developer.gserviceaccount.com". It is safe for the same
     reason as the App Engine account: the manifest check pins the function's runtime account to `arcos-jobs@`, so the
     Compute account is used only for the build. Read the project number, then grant the role with it in place of
     `<PROJECT_NUMBER>`:

     ```bash
     gcloud projects describe arcos-c80cf --format='value(projectNumber)'
     gcloud iam service-accounts add-iam-policy-binding <PROJECT_NUMBER>-compute@developer.gserviceaccount.com \
       --project arcos-c80cf \
       --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" --role roles/iam.serviceAccountUser
     ```

   - `roles/firebase.viewer` on the project. Every functions deploy reads the project's Admin SDK config
     (`firebase.googleapis.com/v1beta1/projects/arcos-c80cf/adminSdkConfig`, `functionsConfig.js`
     `getFirebaseConfig`, called from `deploy/functions/prepare.js`), which needs `firebase.projects.get`.

     ```bash
     gcloud projects add-iam-policy-binding arcos-c80cf \
       --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" --role roles/firebase.viewer \
       --condition=None
     ```

   - a custom role holding `secretmanager.secrets.get`, `secretmanager.versions.get` and
     `secretmanager.secrets.getIamPolicy`, bound on the secrets `BLOCKSCOUT_API_KEY` and `TELEGRAM_BOT_TOKEN` only,
     never on the project. Before every deploy the CLI
     reads the secret and its latest version (`deploy/functions/params.js` `ensureSecret`, through
     `gcp/secretManager.js` `getSecretMetadata`: `secrets.get`, then `versions.get`; the first deploy was refused there
     with a 403 on `GET secrets/BLOCKSCOUT_API_KEY`), and resolves the latest version again
     (`deploy/functions/validate.js`, `validateSecretVersions`: `versions.get`). When `arcos-jobs@` is new to the
     secret (the first deploy, or a function created again), it reads the secret's IAM policy to make sure that account
     can read it (`deploy/functions/ensure.js` `secretsAccessDelta`; `release/fabricator.js` calling `ensure.js`
     `grantSecretAccess`; `gcp/secretManager.js` `ensureServiceAgentRole`). `roles/secretmanager.viewer` has no
     `getIamPolicy`, so it isn't enough. The CLI writes the policy (`setIamPolicy`) only when the `secretAccessor`
     binding of step 3 is missing; the deployer can't, so step 3 comes first.

     ```bash
     gcloud iam roles create arcosSecretDeployReader --project arcos-c80cf \
       --title "arcos: resolve a function secret" \
       --permissions secretmanager.secrets.get,secretmanager.versions.get,secretmanager.secrets.getIamPolicy --stage GA
     gcloud secrets add-iam-policy-binding BLOCKSCOUT_API_KEY --project arcos-c80cf \
       --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" \
       --role projects/arcos-c80cf/roles/arcosSecretDeployReader
     gcloud secrets add-iam-policy-binding TELEGRAM_BOT_TOKEN --project arcos-c80cf \
       --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" \
       --role projects/arcos-c80cf/roles/arcosSecretDeployReader
     ```

     Where the role already exists without `secrets.get`:

     ```bash
     gcloud iam roles update arcosSecretDeployReader --project arcos-c80cf --add-permissions secretmanager.secrets.get
     ```

   - No Firestore role: the workflow deploys no indexes and no rules (Deploying, above). Optional cleanup, for a setup
     that gave the deployer `roles/datastore.indexAdmin` on the project with the `arcos` condition of step 3: remove
     that binding. `--all` removes every binding of that role for the deployer, whatever its condition, which is safe
     because the deployer should hold none. The second command checks it: it should print nothing.

     ```bash
     gcloud projects remove-iam-policy-binding arcos-c80cf \
       --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" \
       --role roles/datastore.indexAdmin --all
     gcloud projects get-iam-policy arcos-c80cf --flatten bindings \
       --filter 'bindings.role=roles/datastore.indexAdmin AND bindings.members:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com' \
       --format 'value(bindings.condition.title,bindings.condition.expression)'
     ```

   - a custom role holding `run.services.getIamPolicy` and `run.services.setIamPolicy`, bound on the function's Cloud
     Run service `arcosindexer` itself, never on the project. The CLI lets `arcos-jobs@` invoke the function through
     the `roles/run.invoker` binding on that service: a create sets the service's policy (`run.services.setIamPolicy`,
     `deploy/functions/release/fabricator.js` `createV2Function`, `gcp/run.js` `setInvokerCreate`), and an update reads
     it and sets it only when the binding differs (`fabricator.js` `updateV2Function`, `gcp/run.js`
     `setInvokerUpdate`). Not `roles/run.admin` on the project: that would let the deployer change every Cloud Run
     service in the project. A project binding limited by an IAM condition on the service's name
     (`resource.name.startsWith(".../services/arcos")`) was tried and did not match: the first deploy was refused with
     "Failed to set the IAM Policy on the Service
     projects/arcos-c80cf/locations/europe-west4/services/arcosindexer". The binding on the service replaces it.

     ```bash
     gcloud iam roles create arcosRunInvokerAdmin --project arcos-c80cf \
       --title "arcos: Cloud Run invoker bindings" \
       --permissions run.services.getIamPolicy,run.services.setIamPolicy --stage GA
     ```

     The service exists only once the function does, so its two bindings come after the first deploy (step 8).

     Optional cleanup, for a setup that made the earlier conditional project binding of this role: remove it, if it
     exists.

     ```bash
     gcloud projects remove-iam-policy-binding arcos-c80cf \
       --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" \
       --role projects/arcos-c80cf/roles/arcosRunInvokerAdmin \
       --condition 'expression=resource.name.startsWith("projects/arcos-c80cf/locations/europe-west4/services/arcos"),title=arcos Cloud Run services only'
     ```

   - No Artifact Registry role (see step 6).
6. The cleanup policy of the functions' image repository, set by the owner. In Cloud Shell, which has no
   `tools/firebase`, run the CLI at the version pinned in `tools/firebase/package.json`:

   ```bash
   npx -y firebase-tools@15.32.0 functions:artifacts:setpolicy --location europe-west4 --project arcos-c80cf
   ```

   npx pins the CLI's version but not its dependency tree (that is what `tools/firebase/package-lock.json` does for the
   workflow), which is fine for a one-off command the owner runs.

   After a deploy, the CLI reads the `gcf-artifacts` repository of `europe-west4` to check its cleanup policy
   (`deploy/functions/release/index.js`, `setupArtifactCleanupPolicies`). The deployer can't read it, so that check
   fails quietly and the deploy goes on; the policy is never set by the deploy. (A deployer that could read the
   repository, as under `roles/editor`, would find no policy and, non-interactive, stop the deploy with an error.)
   Without it, old images pile up and are billed. The repository is created by the first functions build: if the
   command says it doesn't exist yet, run it again right after the first deploy.
7. The repository variable `ARCOS_FUNCTIONS_READY` set to `true`.
8. The first deploy, in two runs (Actions, Deploy, Run workflow, `targets: functions`):
   1. The first run creates the function and then fails at "set invoker": the deployer has no binding on a service that
      didn't exist a moment before. `arcosIndexer` then exists with no `roles/run.invoker` binding and no Scheduler job
      (the CLI creates the job after the function's create step, which didn't finish), so nothing runs. Until the
      owner adds the bindings below, a push to `main` also deploys the functions (after the sites) and fails at "set
      invoker" the same way.
   2. The owner adds the two bindings on the service: the deployer's custom role, and `roles/run.invoker` for
      `arcos-jobs@`:

      ```bash
      gcloud run services add-iam-policy-binding arcosindexer --region europe-west4 --project arcos-c80cf \
        --member "serviceAccount:arcos-deployer@arcos-c80cf.iam.gserviceaccount.com" \
        --role projects/arcos-c80cf/roles/arcosRunInvokerAdmin
      gcloud run services add-iam-policy-binding arcosindexer --region europe-west4 --project arcos-c80cf \
        --member "serviceAccount:arcos-jobs@arcos-c80cf.iam.gserviceaccount.com" --role roles/run.invoker
      ```

   3. The second run completes: with `--only functions:arcos` the function is updated, never skipped as unchanged; the
      update finds the invoker binding in place, keeps the service's other bindings, and creates the Scheduler job.

   The pinned CLI allows no cleaner order: the service is created by the function's create, and the same step writes
   its invoker binding with a policy that replaces the service's whole policy (`setInvokerCreate`), so no binding can be
   placed ahead of it. If the function is ever deleted and created again, its service is new, and the same two runs
   apply.

The deploy log's warning "Couldn't find firebase-functions package in your source code" is expected: the deploy hands
the CLI the built bundle without its `node_modules`, and Cloud Build installs the packages.

Settled by the first deploy without `roles/editor`, which succeeded once the deployer held the roles above:
- Every 2nd-gen functions deploy asks Service Usage to generate the service identities of Pub/Sub and Eventarc
  (`services/<service>:generateServiceIdentity`, `deploy/functions/prepare.js`). `roles/serviceusage.serviceUsageConsumer`
  covers that call; `roles/serviceusage.serviceUsageAdmin`, which could enable any API, isn't needed.
- A functions update needs `actAs` on the default Compute account (step 5): the production deploy was refused without
  it, and went through once it was granted.

To check on later deploys:
- The first deploy logged that it ensured `arcos-jobs@` access to `BLOCKSCOUT_API_KEY`. The CLI logs that whether or
  not it wrote the binding, so check step 3's binding is in place (the command in step 3). Later deploys don't touch the
  secret's policy while `arcos-jobs@` already runs the function.
- Any other refusal names its permission: add it to the narrowest role above that fits, never `roles/editor`.

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
`expired`, `feeds`, `explorerCalls` and Watchdog's `watch` counters (above); a halted indexer logs `arcosIndexer halted`
with its reason. No line carries an address: the run line leaves out Watchdog's page cursor, a `watchState` doc id
that names a token. In Firestore, `indexer/mainnet` shows the cursor (`block`), `lastRunAt`, the day's explorer calls
and Watchdog's `watchCursor`.

## What it costs

At the rate measured on 2026-10-02 (a 10,000-block window, about 84 minutes, held 170 qualifying pools: about two a
minute), a steady-state run makes:

| | Per run | Per month (43,200 runs) |
|---|---|---|
| Arc RPC (indexer) | 2 calls: the head and one window | about 86,000 |
| Arc RPC (inspections) | about 15 to 40 `eth_call`s per inspection, up to 3 inspections | about 2 to 5 million |
| Blockscout PRO | up to about 6 per inspection | at most 3,000 a day (the budget), about 90,000; the rest of the plan's quota is the site's |
| Firestore reads | about 30: the controls and the lease 2, the window's pools and tokens about 4, the cursor 1, the queue up to 12, each inspection's pools 1 or 2, the feeds 4, the end of the run 1; plus up to 50 for the feed rebuilt that run | about 3.5 million |
| Firestore writes | about 17: the lease 1, pools and tokens about 4, the cursor 1, each inspection 2, the feeds up to 4, the end of the run 1 | about 0.7 million |
| Function time | a few seconds, plus up to 15 seconds per inspection | inside or near the free tier at the default CPU of a 512 MiB function (the function sets no `cpu` option) |
| Arc RPC (Watchdog) | 3 per watched token on the page, at most 120 (40 tokens); 0 explorer calls | about 5 million at the cap, far fewer with a few watched tokens |
| Firestore reads (Watchdog) | about 2 + 3 per token on the page (the `watchState`, `tokens` and `pools` docs), at most about 122; plus the fan-out's and the sends' reads only when there is work | about 5.3 million at the cap, about $1.60 |
| Firestore writes (Watchdog) | 0 when nothing changed; 1 per first sight; 1 + k per change with k alerts; 1 per delivery created; 1 per send; the cursor rides on the end of the run | a few a minute at most; the hard ceiling during a fan-out is 1,000 delivery creates + 60 send updates + 40 state writes |
| Telegram | at most 60 messages a run, 3 per chat | at most 60 a minute |

The first run's 24-hour backfill reads and writes about 6,000 documents once. Firestore single-region prices are about
half of the multi-region $0.06 per 100,000 reads and $0.18 per 100,000 writes, so the indexer's Firestore use is about
$2 a month. The explorer budget covers about 500 inspections a day; at about 2,900 new tokens a day, most reports
are made on RPC only and marked `degraded` unless the budget grows.

## Tests

- `npm test -w @arcos/functions`: the pure parts (windows, the log decoder on real mainnet logs, pool selection, the
  queue, the feeds, the RPC deadline, Watchdog's reader on a fake chain, the Telegram sender on a stubbed Bot API with
  every outcome and the token in no result, the delivery state machine), and a real build of the bundle and its
  manifest, read back by the pinned Firebase CLI and passed through the deploy job's manifest check.
- `npm run test:emulator -w @arcos/functions`: whole runs against fake chains in the Firestore emulator, under the
  `demo-arcos` project id only: the windows, the queue, a crash inside a window, a run whose inspections fail, the feed
  rebuilt in turn, the lease and the cursor that only moves forward; and Watchdog's step: first sight, a change with
  its alerts and deliveries, the fan-out resumed after a crash, retries and the 4-attempt limit, a blocked chat
  unlinked, the 429 pause, the switches, the 40-token page and its cursor, the time limits, the breaker and the logs.
- `npm run test:live -w @arcos/functions`: three read-only calls to Arc mainnet. Not part of CI.
