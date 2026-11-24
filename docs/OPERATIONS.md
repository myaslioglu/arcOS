# Operations

What runs where, what the owner can switch in the console, how the jobs deploy, what they cost, and how to check them.
Deploying the sites themselves is in [DEPLOYING.md](DEPLOYING.md).

## What runs where

All of it is in the Firebase project `arcos-c80cf`, region `europe-west4`.

| Piece | Runs as | Reads | Writes |
|---|---|---|---|
| App Hosting `arcos`: https://4rcos.com | `arcos-web@` | Arc mainnet RPC, Blockscout PRO API, Firestore `arcos` (pools, positions, positionsIndex, radarFeed, indexer, stats) | nothing in Firestore yet |
| App Hosting `arcos-testnet`: https://testnet.4rcos.com | `arcos-testnet-web@` | Arc testnet RPC and explorer | nothing; it has no Firestore access |
| Function `arcosIndexer` (codebase `arcos`, [functions/](../functions)) | `arcos-jobs@` | Arc mainnet RPC, Blockscout PRO API, the Telegram Bot API (sends only), Firestore `arcos` (`watches`, `users`; `count()` aggregations of `users`, `watches`, `watchState`, `tokens`) | Firestore `arcos`: `indexer`, `pools`, `tokens`, `reports`, `radarFeed`, `watchState`, `alerts`, `deliveries`, `stats`, `statsDays`, `positions`, `positionsIndex`, `users.telegram` (cleared when a chat blocked the bot) |
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
   five contracts: the ArcOS TokenFactory (`TokenCreated`), the Uniswap v2 factory (`PairCreated`), the Uniswap v3
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
   Inspector as extra pools, and the positions the index holds for the token's v4 pools go with them (below, "The
   position index"). Each report is kept 90 days (`reports/`, TTL on `expiresAt`); the token keeps the summary,
   its best pool and Radar's two flags.
6. Brings the four Radar first pages (`radarFeed/mainnet:{all,liquid,passing,liquid-passing}`) up to date with the
   tokens the run changed, and rebuilds one of the four from its query, a different one each minute, writing a page
   only when it changed. A page that missed a change (a run that died between an inspection and this step) is whole
   again within four runs.
6b. Stats (below): counts ArcOS's usage on chain in windows of its own cursor, and refreshes the counts of ArcOS's own
   data every 10 minutes. Skipped when the `stats` switch is `false`.
6c. The position index (below): records the liquidity positions the Uniswap v4 PoolManager's `ModifyLiquidity` logs
   name, and a pool doc for every v4 pool its `Initialize` logs name that has none, in windows of its own cursor.
   Skipped when the `positions` switch is `false`.
7. Ends the run: `lastRunAt` (never moved back), the run's explorer calls added to the day's count, Watchdog's page
   cursor (`watchCursor`) when the step ran, and the lease given back if it is still this run's.

Once the window phase (steps 2 to 4) is over, steps 5, 6 and 7 run whatever fails in step 4b, steps 6 and 7 run
whatever fails in step 5, and a failure in step 6, 6b or 6c doesn't stop step 7; the error's name is in the run's log line
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
| `block` | a block number | The cursor: the last block fully read. Lowering it makes the next runs read those blocks again (nothing is duplicated). Lowering it below the block the indexer first started at does not index the older v4 tokens: the position index's step has given their pools a doc, and a pool that has one counts as handled. Never raise it past blocks not yet read: they would be skipped. The indexer itself only ever moves it forward. |
| `runningUntil`, `runId` | (set by the indexer) | The lease of the run in progress, `null` between runs. While `runningUntil` is in the future, a new run skips. Leave them alone: a lease left by a run that died expires 150 seconds after it was taken. |
| `watch` | `false` | Stops the whole Watchdog step (no check, no fan-out, no send). A missing field reads as `true`. |
| `telegram` | `false` | Stops Watchdog's Telegram sends only: the checks still run, alerts and deliveries are still written, and the deliveries wait as `pending` (they expire after a day). A missing field reads as `true`. |
| `stats` | `false` | Stops the whole Stats step (no `eth_getLogs`, no write to `stats`/`statsDays`, no server counts). The totals and the cursor stay where they are, and the step carries on from there when the field is `true` or missing again. |
| `positions` | `false` | Stops the position index's step (no `eth_getLogs`, no write to `positions`/`positionsIndex`, no pool doc added). The positions and the cursor stay where they are, and the step carries on from there when the field is `true` or missing again. The readers respect it at once: while it is `false` no positions are served (`readPositionsCursor` answers null), so from the next inspection on the liquidity-lock check runs as it did before the index, for every token: v2 pairs are judged on their LP tokens and a v4 pool reads "Couldn't check liquidity locks" (the site keeps a token's answer 60 seconds). Nothing gets worse than it was before the index. Switched on again, the step catches up from its cursor, and the v4 answers come back once the cursor is within 10,000 blocks of the head. |
| `watchCursor` | (set by the indexer) | The `watchState` doc id Watchdog's checks ended at; the next run's page starts after it. Set it to `null` to start the round from the first token. |

The indexer never writes `paused`, `inspect`, `watch`, `telegram`, `stats` or `positions`. Change them only between runs (any time is fine: the
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
| `arcosIndexer run` | `watch: {checked, unread, failed, alerts, writes, deliveriesCreated, fannedOut, sent, sendFailed, skipped, error}` | The step's counters; `watch: null` when the step didn't run. `skipped` is `off` (the switch) or `late` (the run reached 55 s before the step). `error` is the name of the error that stopped the fan-out or the sends, else `null`. The page cursor is left out of the line (it is a `watchState` doc id, which names a token); read it in Firestore, `indexer/mainnet.watchCursor`. |
| `arcosIndexer watch read failed` | `code`: `timeout`, `transport` or `reverted` | One token's read failed; its fields stay as stored. At most 5 a run, then `{suppressed: true}`. |
| `arcosIndexer watch reads stopped` | `code: breaker` | 3 consecutive transport or timeout failures: the run's remaining reads were skipped. |
| `arcosIndexer watch check failed` | `error`, `code`, `details` (masked) | A token's Firestore read or write failed; it is read again on its next turn. At most 5 a run. |
| `arcosIndexer telegram send failed` | `code` (the delivery's error code), `status` (a 5xx), `attempts` | One send failed. At most 5 a run. |
| `arcosIndexer telegram paused` | `code`: `rate_limited` or `unauthorized`; `seconds` | This instance makes no send for `seconds`. |
| `arcosIndexer telegram not configured` | | The secret holds no token; sends are off on this instance. |
| `arcosIndexer watch stopped` | `phase`: `checks`, `fanout` or `sends`; `error`, `code`, `details` (masked) | The phase failed on the Firestore side; the run went on to its inspections, with the error named in the run line. A `fanout` or `sends` failure keeps the checks' counters, their cursor and the fan-out's counters in the run line and the cursor in `indexer/mainnet`; a `checks` failure leaves `watch: null` and the cursor as it was. |

Signs to look for: `unread` close to `checked` for many runs (the RPC endpoints are refusing the reads; the breaker
line says so), `sendFailed` with `code: telegram_5xx` (Telegram's side), `arcosIndexer telegram paused` with
`unauthorized` (the token was revoked or the secret holds the wrong value: add a new version, as under Setting it up,
step 3, and deploy), and
`deliveries` docs expiring (`error: expired`) while `telegram` is `true` (sends were paused or failing for a day).

## Stats

The usage counter behind the Stats window and `GET /api/stats`. It is step 6b of the indexer run (mainnet only), with a
cursor and totals of its own, apart from the indexer's.

**What it reads.** One `eth_getLogs` per window of at most 10,000 blocks, over four contracts: the TokenFactory
(`TokenCreated`), both Multisends (`Drop`: the current `0x8459…480e` and the previous `0x03dd…af47`, from
`PREVIOUS_MULTISENDS` in `packages/chain/src/usage.ts`) and the FeeController (`KeyAdded`, `FeeChanged`). The fee events
rebuild the Mint and Drop fees at each block, so the fee totals are exact. Windows are halved when refused, like the
indexer's. A step is bounded: at most 20 windows a run, none started after 100 s, no call waited for past 108 s.

**What it writes** (Firestore `arcos`, deny-all rules, the Admin SDK only):

- `stats/mainnet`: `block` (the cursor: the last block folded), `fromBlock` (22,742,796, the FeeController's
  deployment, 2026-09-25), `head` (the finalized head the last window was read against), `fees` (the three values as of
  `block`), `totals` (counts, `byTemplate`, `rowsSubmitted`/`rowsDelivered`/`rowsFailed`, `feesMint`/`feesDrop` in wei
  as decimal strings), `excluded` (what the left-out wallets did, counted apart), `server` (below), `onchainSince`,
  `updatedAt`. No address is stored.
- `statsDays/mainnet:{yyyy-mm}`: `days.{yyyy-mm-dd}.{tokensCreated, drops, rowsDelivered}`, by increments in the same
  transaction as the totals. Nothing reads them yet.

**Exactly once.** A window is applied in one transaction that reads `stats/mainnet` and then: stops if `block` is
already at or past the window's end (applied before); stops if `block` is not the block before the window's start
(another run moved it; the next pass reads again from the doc's cursor); otherwise folds the window's logs into the totals
and writes the totals, the fees, `block`, `head`, `updatedAt` and the day increments together. A crash before the commit
writes nothing and the window is read again; one after it is "applied before". Each log is counted once per window
(a duplicate at the same block and log index is dropped, one outside the window is ignored), and logs are folded in
(block, log index) order.

**Left out.** The project wallet's own `TokenCreated` and `Drop` events (`STATS_EXCLUDED_WALLETS` in
`functions/src/indexer/stats.ts`) go to `excluded` and into no total, template, fee or day. The public answer says so in
words and gives no address. To change the list, change the constant and reset the stats doc (below): the totals are not
recomputed by themselves.

**Server counts**, `stats/mainnet.server`, every 10 minutes (`countedAt`): `users`, `users` with a linked chat,
`watches` and `watchState` of the network, `tokens` of the network and those whose `inspect.state` is `done`: six
`count()` aggregations (single-field or equality filters only, so no composite index), and four small
`orderBy(...).limit(25)` reads for the "since" dates (`users.createdAt`, `users.telegram.linkedAt`, and the oldest of the
first 25 `watches` and `tokens` docs that belong to the network; single-field orders, so no index). The run line's
`stats.undated` counts events added to the totals that carried no block time and so are in no day bucket.

**The public answer** is `statsAnswer` in `packages/data/src/stats.ts`: counts and dates, no address except ArcOS's own
public contracts, and no fee or revenue total (they are stored, not served). The route is `GET /api/stats`: mainnet only
(404 elsewhere), 60 requests a minute a client, `cache-control: public, s-maxage=60, stale-while-revalidate=300`,
`access-control-allow-origin: *`, 503 with `retry-after: 60` when `stats/mainnet` can't be read. It reads one document,
kept 60 s in each instance with the same 1.5 s deadline and 60 s cooldown as `/api/radar`; the site's
`roles/datastore.user` on `arcos` covers it. Logs: `stats failed <name> [<gRPC code>]`.

**The first run, and the backfill.** The first run creates `stats/mainnet` with the cursor one block before
`fromBlock`, then catches up 20 windows a run. From 22,742,796 to the head on 2026-11-08 (block 30.2 million) is 749
windows: about 38 runs, so 40 to 50 minutes at one run a minute. The step has its own budgets: no window starts after 100 s
of the run, and none more than 15 s after the step began, so a backfill run is at most about 15 s longer and the next
minute's tick isn't pushed out (one instance, no retry); a run whose inspections ran long reads fewer windows. One window
took about half a second on rpc.mainnet.arc.io (400 ms pacing plus the call and the transaction), so the 15 s budget and
the 20-window cap bind at about the same point. While it catches up the Stats window says the on-chain counts are
still catching up (`asOf.behind` over 2,000 blocks), and the counts rise as blocks are read; the server counts are
there from the first run. After that a run applies one window of about 118 blocks.

**Redoing a count.** To count again from the start (the exclusion list changed, say): set `stats` to `false` on
`indexer/mainnet`, wait for the run in progress to end (`runningUntil` is `null`, or a minute has passed), delete the
`statsDays` docs and the document `stats/mainnet`, then set `stats` back to `true` (or delete the field) so the next runs
backfill again. Deleting while a run is in the middle of the step could leave that run's window applied to a doc created
a moment later. To pause counting without losing anything, set `stats` to `false` and nothing else.

**Cost.** Backfill: about 750 `eth_getLogs`, 1,500 transactions (the step's own `ensureStats`, which raises `head`, and the window: 2 reads and 2 writes in all,
plus a `statsDays` write where a window had events); no explorer calls. Steady state: 1 `eth_getLogs` a run (about 43,000 a month),
2 transactions a run (about 86,000 reads and 86,000 writes), and every 10 minutes six aggregations and four small reads (about
4,300 rounds a month; an aggregation bills one read per 1,000 index entries it counts). Well under $1 a month.

**Checking a number.** Open the contract's logs from the Stats window (or the README's table), filter the event, and
count: `TokenCreated` on the TokenFactory, `Drop` on both Multisends. The explorer's totals include the left-out wallet's
events, which `stats/mainnet.excluded` holds in the console. `fees` should match the FeeController's `feeOf` for
`MINT_FLAT`, `DROP_PER_RECIPIENT` and `DROP_MIN` (read on the explorer) once the counter is caught up.

The run line gains `stats: { windows, tokensCreated, drops, behind, error }`: counts and the name of an error, no
address. `behind` is the blocks the Stats cursor is short of the run's head.

## The position index

What Inspector's liquidity-lock check reads Uniswap v4 pools from. A v4 position is an entry in the PoolManager keyed by
(pool id, owner, tickLower, tickUpper, salt), with no token of its own, and only the PoolManager's `ModifyLiquidity`
logs say which entries exist. Step 6c of the indexer run (mainnet only) records them, with a cursor of its own, apart
from the indexer's and from Stats'. The same step completes the list of v4 pools: the same windows carry the
PoolManager's `Initialize` logs, and every v4 pool the pool index keeps (a quote currency on exactly one side) gets a
doc in `pools` if it has none. Code: `functions/src/indexer/positions-run.ts` and `positions-store.ts`; the reads
are `indexedPositions` and `indexedPositionsFor` in `packages/data/src/server/positions.ts`; the check is
`packages/inspector/src/v4-positions.ts` and `checkLpLock`.

**What is stored.**
- `positions/mainnet:{poolId}:{owner}:{tickLower}:{tickUpper}:{salt}`: one doc per position, under the PoolManager's
  own key for it: `poolId`, `owner` (the event's `sender`), `tickLower`, `tickUpper`, `salt`, `tokenId` (the
  PositionManager NFT, when the PositionManager holds the position: its salt is the token id) and `firstBlock`. No
  amount: the check reads each position's liquidity from the chain. Every `ModifyLiquidity` is recorded, whatever the
  pool, because a pool created before the pool index began (around 2026-10-01) has no doc in `pools`. A doc is never
  deleted, so a position that was emptied stays listed and reads as holding nothing.
- `pools/mainnet:{poolId}`, for v4 pools from before the main indexer's first block (about 2026-10-01): the same doc
  the main indexer writes (`poolToDoc` of `selectPool`'s pool, the key with its hook), with no depth sampled. Only
  the pool doc: no token doc, nothing queued for inspection, nothing in Radar. This is how an inspection finds an old
  pool with a hook or a non-standard fee, which its own discovery never probes; without it a burned small pool could
  pass beside a larger pool nobody had looked at.
- `positionsIndex/mainnet`: `block` (the cursor: the last block whose logs are all in `positions` and `pools`),
  `fromBlock` (1,948,056, the PoolManager's deployment), `head` (the finalized block at the last run) and `updatedAt`.

**Not fighting the main indexer.** In `pools`, a doc is the main indexer's mark that a pool's token is handled, so the
step must never create one for a pool the main indexer has yet to see. It never reads past the main indexer's cursor
(`indexer/mainnet.block` as this run left it): every pool at or below it that the main indexer records, it has
recorded already, and the step writes pool docs with `create`, which Firestore refuses over a doc that exists (a
refused batch is read again and what is still missing is written). So in
practice it adds the pools older than the main indexer's first block and nothing else. If the main indexer is behind,
the position index waits behind it.

**Exactly once.** A window's positions and pools are written first, each under its own key and only if it isn't there
yet, and the cursor is moved after them, in a transaction that stops if the cursor isn't at the window's start. A run
that dies in between, or runs out of time, repeats the window and writes only what is still missing; applying a window
again changes no doc. A reader that takes the
cursor first and the positions after it sees every position opened up to that cursor.

**What Inspector does with it.** An inspection gets the index's pools for the token (at most 50, with a flag when the
index holds more) and, for each v4 pool among them, the position keys the index holds, at most 500 a pool and 2,000 in
all, and the cursor. It reads the blocks after the cursor itself (at most 10,000 blocks, three `eth_getLogs`:
`Initialize` with the token as currency0 and as currency1, then the pools' `ModifyLiquidity`), then every position's
liquidity and each NFT's owner at one block, and checks that the in-range positions add up to the pool's active
liquidity. With that it does one thing: it warns about liquidity a wallet can withdraw. It never makes a pass and never
a fail: every pass, fail and unknown of lp-lock is what the check from before the index says (v2 LP tokens only), and a
warning from the positions takes the place of that check's pass or unknown, never of its fail. That check's words stand
too, but for its unknowns that say positions "can't be read without an index yet". Once the index was read, those say
what was read (that Inspector read who holds the v4 positions, that positions wallets can withdraw are under the
thresholds for a warning, and that this confirms no lock) or what stopped the reading, and that Uniswap v3 and Aerodrome
positions aren't read, without tying that to an index. A launch
burned into a v4 pool reads "couldn't check"; one held by a wallet reads as a warning, titled "Wallets hold most of the
USDC Inspector found in its pools" once wallets hold 1,000 USDC there and more than half of it, and "Some liquidity
isn't locked" otherwise (a fresh wallet-held launch nobody has bought from, say). Failing a token on its v4 positions
is a follow-up: it needs the USDC that could really be sold into, matched holder by holder to the tokens for sale, or the deployer's identity. The rule, who
can make which warning and at what cost are in the README, "How Inspector decides things", and in the header of
`packages/inspector/src/checks.ts`.

The v4 reading is left out when: there is no index (testnet, or it couldn't be read), it is switched off, its cursor is
more than 10,000 blocks behind, the token has no v4 pool, a pool has more than 500 positions, the token has more than
50 v4 pools, the positions don't add up (a gap in the index), or a pool of the token was created since the cursor and
the inspection wasn't given it. A pool created since the cursor that the inspection does have is read from those
blocks alone. Pools against a currency other than USDC, EURC or native USDC are in neither list and are never counted.
The same when the v4 reads fail or outlast the inspection's deadline (a node refusing the tail's `eth_getLogs`, which
Arc does past 20,000 results, is one way): the old check is started first, runs beside them, and answers. Its status
always stands. Its words stand word for word only when there was no index to use (none, switched off, or more than
10,000 blocks behind); in the other cases a detail that would say the positions can't be read without an index says
what stopped the reading instead: the blocker's own sentence (for a pool with too many positions, "A Uniswap v4 pool of
this token has more than 500 positions, more than this check reads."), or that Inspector ran out of time, or couldn't
finish reading who holds the v4 positions. Holders are classified by their code, up to 500 of them, in one
state-overridden `eth_call` per 250 (40 single `eth_getCode` reads when a node refuses the override).

Known limits, accepted: a stored inspection is as of its block and nothing re-inspects a token when its price moves; a
token whose old pools the backfill adds later is not re-queued for inspection (a follow-up: re-queue the tokens of
pools the positions step creates); anyone can take the v4 reading away from a token by creating 51 empty pools for it,
which leaves it with the old check's answer.

**The reads, and their bounds.** The indexer's own inspections, `/api/inspect`, `/t` and `/badge` read the index
directly; the Inspector window gets it from `GET /api/pools/[token]` (`positions`, `truncated`).
- Pools first: one query, 51 docs at most (`indexedPoolList`: 50 and one more to know there are more).
- Positions after them, only for v4 pools the index lists for the token: an address with no indexed pool costs no
  positions read. Four pools at a time, in order, each asked for no more than what was left of the 2,000 when its four
  began (and no more than 500), plus one; a pool over its share, or past the total, ends the reading. So at most 2,000
  docs plus 1,500 plus one a pool, whatever the pools hold.
- Two more reads by id for the cursor and the switch (`positionsIndex/mainnet`, `indexer/mainnet`).
- On the site the positions have 1.5 seconds of their own and no cooldown: when they are slow or fail, the pools are
  still answered, `positions` is left out, and the next token is read as usual (the pools' read keeps its 1.5 seconds
  and its 60-second cooldown). In the indexer the positions read has 3 seconds (`POSITIONS_READ_MS`); past it the
  inspection goes on without them. Logs: `positions failed <name>` on the site, `arcosIndexer positions not read` in
  the function.
- The queries are two equality filters (`network` and `poolId`, or `token`), served by Firestore's single-field
  indexes: no composite index, so nothing to deploy to `firestore/arcos.indexes.json`, and the rules don't change
  (every client read is refused; both readers use the Admin SDK with `roles/datastore.user` on `arcos`).

**The first run, and the backfill.** The first run after the deploy creates `positionsIndex/mainnet` with the cursor
one block before 1,948,056 and starts reading. From there to the head on 2026-11-20 (block 32.2 million) is about
3,030 windows of 10,000 blocks. The step has its own budgets: no window starts after 100 s of the run or more than
10 s after the step began, at most 12 windows a run, no RPC answer is waited for past 106 s, and no round of a window's
writes starts past 108 s. It runs after every other step (before Stats only while it is backfilling: see below), so it
never moves the indexer's own work. When the node refuses a window it is
retried at the width the node suggests (9,473 blocks, say), or at half when it suggests none; nothing that wide is tried
again in that run, and the width that worked is stored on `positionsIndex/mainnet` (`span`), where the next run starts.

A window is one `eth_getLogs` (400 ms after the previous call) and its writes. The writes go in chunks of 400 docs,
six chunks at a time, each chunk one read of which docs exist and one batch of the new ones. Most windows are sparse
and take about a second, so a run fits about 8 into its 10 s. Some are dense: the densest on mainnet (blocks 21,185,000
to 21,194,472) has 19,996 logs, 7,678 of them new pools, which is about 50 chunks and 10 to 20 s of writes. A run that
starts such a window can therefore end up to about 20 s later than it otherwise would, and never starts a round of writes past 108 s
plus one round. A window the run's time doesn't cover is left unfinished (`arcosIndexer positions window unfinished`
in the log, a warning and not an error): what was written stays, the cursor doesn't move, and the width is halved and
stored on `positionsIndex/mainnet` (`span`), so the next run reads half as many blocks. The same when a window's logs
don't arrive in time (`arcosIndexer positions window failed` with `DeadlineExceeded` or a timeout). It halves again
each run, down to one block, until a window fits what the run has left, and doubles with every window applied. Once
every doc of a window is stored its cursor moves even if the time has just run out.

**If the cursor stops.** The function is killed at 120 s (or when it runs out of memory), and a killed run stores
nothing of what it was doing. So before a window is read it is written down on `positionsIndex/mainnet` as `attempt`
(`from`, `width`, `at`), and a run that finds `attempt.from` still at the block after the cursor knows the last one died
on that window: it logs `arcosIndexer positions attempt died`, halves the width, and sets `ceiling` to it, in force
until the cursor has passed `ceilingUntil` (the end of the window that died), so the width can't double straight back
into it. An attempt that ends in any way the step sees removes the marker, and a marker more than ten minutes old is
ignored (the step was off in between). The step starts no window after 100 s, waits for no RPC answer past 106 s and
starts no round of writes past 108 s.

While the index is more than 10,000 blocks behind the head (its backfill), its step has a slot early in the run:
right after the indexer's own windows, before Watchdog and the inspections. There it starts windows for 20 s from where
it begins and never after 40 s of the run, waits for no RPC answer past 45 s and starts no round of writes past 47 s,
so it is done by about 50 s, before the 55 s past which Watchdog starts no check. At the end of the run a backfill had
only what the inspections left, which can be nothing for hours. What it costs, during the backfill only: Watchdog and
the inspections start up to about 20 s later in a run (their own limits are times of the run and don't move, so each
does that much less in a busy minute), and a window that kills the function takes that run's Watchdog and inspections
with it, for the few runs it takes to narrow. If the early slot had no time, the step is tried again at the end of the
run. Once within 10,000 blocks it is back at the end, after Stats, where it reads its one window. When the step starts no window, the run line's `positions`
says why in `reason` (`no-time`: the run was past 100 s; `off`: the switch) and still gives the real `behind`.

To watch it from outside, `GET /api/pools/<any token address>` returns `positions.cursor` and, beside it,
`positions.progress`: `span`, `ceiling`, `ceilingUntil`, `attempt` (`from`, `width`) and `lastRun`.

`lastRun` is written at the end of every call of the step, whatever it did: `at` (seconds since the epoch: it should be
under two minutes old), `startMs` (how far into the run the step began), `windows` (how many it applied), `slot`
(`early` or `late`), and `reason` (`no-time`, `off`) or `error` (an error's name) when it did nothing or was stopped.
- `at` fresh, `windows` above 0: it is working; `cursor` moves.
- `reason: "no-time"` with a large `startMs`: the run was past the slot's cutoff before the step's turn. In the early
  slot that means the indexer's own windows took 40 s; at the end, that the run was past 100 s.
- `error` set: that is what stopped it (`DeadlineExceeded`: its logs didn't arrive in time; anything else is in the
  function's log under `arcosIndexer positions`).
- `at` old, or no `lastRun` at all, while the indexer is running: the step isn't being called, or the function dies
  before its end. An `attempt` that stays put says which window it dies on.

Reading the rest:
- `cursor` still, `attempt.from` = cursor + 1 and `span` falling run by run: it is narrowing on a dense stretch. Wait.
- `cursor` moving and `span` small with a `ceiling`: it is through the worst and will widen past `ceilingUntil`.
- `cursor` still and no `attempt` at all: the step isn't starting. Look at the run line's `positions`: `reason` is
  `no-time` when the run was past 100 s before the step's turn, `off` when it is switched off.
- `span` at 1 and the cursor still: one block is too much for a run. That needs a larger function, not a narrower window.

So the backfill takes some 300 to 500 runs: 5 to 8 hours at one
run a minute, longer while inspections run long.

Until the cursor is within 10,000 blocks of the head, the liquidity-lock check gives exactly the answers it gave before
the index (v2 pairs on their LP tokens; for a v4 pool, "positions in them can't be read without an index yet"), since
until the backfill is done neither the positions nor the token's old v4 pools are all listed. The warnings
from positions start on their own once it has caught up, and so do the details that say what was read in place of
"can't be read without an index yet". Watch `positionsIndex/mainnet.block` against `head`, or
`behind` in the run line. After that a run reads one window of about 120 blocks.

**Redoing it.** Set `positions` to `false` on `indexer/mainnet`, wait for the run in progress to end, delete the
document `positionsIndex/mainnet` (and the `positions` docs, if they are to be rebuilt too; leaving them is harmless,
since a position already there is left as it is), then set `positions` back to `true` or delete the field. To read some
blocks again without starting over, lower `positionsIndex/mainnet.block`: nothing is duplicated.

**Cost.** Backfill: about 3,030 `eth_getLogs`, and per window two transactions (the step's `ensure`, which raises
`head`, and the cursor) plus one read per position or pool named and one write per new one; the PoolManager emitted about
2,600 `ModifyLiquidity` a day in November 2026, so the whole history is some hundreds of thousands of events: well under
$1. Steady state: 1 `eth_getLogs` a run and about 2,600 reads and at most as many writes a day. An inspection reads the
token's pools, two docs by id, and one query per v4 pool of the token (one read when empty, else one per position,
2,000 at most in all); the site keeps a token's answer 60 seconds. No explorer calls.

The run line gains `positions: { windows, positions, pools, behind, error }`: the windows applied, the new positions
stored, the pool docs added, the blocks the cursor is short of the run's head, and the name of an error. No address.

## The site's reads

- `GET /api/pools/[token]` answers the token's indexed pools, v4 pool keys included (at most 50, with `truncated: true`
  when the index holds more), and under `positions` the position index for the token's v4 pools (the cursor, and per
  pool id the position keys, at most 500 a pool and 2,000 in all, else `truncated`), kept 60 seconds at the CDN.
  `positions` is absent before the position index's first run, while its switch is off, or when it couldn't be read
  in time.
- `GET /api/radar` answers the first Radar page of a filter (the newest 50 tokens, each with Inspector's counts), kept 20
  seconds at the CDN; the Radar window polls it every 20 seconds.
- `GET /api/stats` answers the usage counts (above, "Stats"), kept 60 seconds at the CDN; the Stats window polls it every
  60 seconds. Public, with CORS open to any origin; 404 on testnet.
- `/api/inspect`, `/t` and `/badge` pass the index's v4 pools and their positions to the Inspector, and the Inspector
  window reads them from `/api/pools`. This is how a v4 pool with a hook, or with a fee outside the five standard tiers,
  gets inspected, and how the liquidity-lock check reads who holds a v4 pool's liquidity.
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
`expired`, `feeds`, `explorerCalls`, Watchdog's `watch` counters (above), Stats' `stats` counters and the position index's `positions` counters; a halted indexer logs `arcosIndexer halted`
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
| Arc RPC (Stats) | 1 `eth_getLogs` (the window since Stats' own cursor); 20 a run while it backfills | about 43,000; about 750 once for the backfill |
| Firestore (Stats) | 2 transactions: `ensureStats` (1 read, 1 write to raise `head`) and the window (1 read, 1 write, plus 1 more write where it had events); every 10 minutes 6 aggregations and 4 small reads | about 86,000 reads and 86,000 writes, plus about 100,000 read units of aggregations; well under $1 |

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
  Stats' unit tests (`stats.test.ts`) decode and fold generated logs of both Multisends: fee changes in a window and in
  one block by log index, the minimum fee, failed rows, native against token drops, the left-out wallet, removed logs,
  unknown topics, duplicates, day keys. Stats' emulator suite (`stats.test.ts`) applies a window twice, from two runs at
  once, out of order and across a month; runs the step through `runIndexer` (cursor, window cap, time limit, switch,
  refused and failed windows, the 10-minute server counts, no address in a log line). The position index's unit tests
  (`positions.test.ts`) decode generated `ModifyLiquidity` logs and hold its caps and time limits against the
  Inspector's and the function's; its emulator suite (`positions.test.ts`) applies a window twice and after a crash,
  runs the step through `runIndexer` (cursor, window cap, both time limits, switch, refused and failed windows), checks
  the pool docs it adds (an old hooked pool, no token doc, a doc of the main indexer's left alone, nothing read past
  the main indexer's cursor) and what an inspection is handed.
- `npm run test:live -w @arcos/functions`: read-only calls to Arc mainnet (the indexer's three, and Stats' decode of the
  first window from the FeeController's deployment). Not part of CI.
