# Deploying

How a change reaches https://4rcos.com and the testnet site, https://testnet.4rcos.com. A deploy runs from GitHub
Actions, signs in to Google Cloud without a key file, and starts only after the checks pass and the owner approves it.
Both sites come from the same commit under the same approval: 4rc.OS from the App Hosting backend `arcos`, the testnet
site from the backend `arcos-testnet` (see [The testnet site](#the-testnet-site)). The testnet site takes part only
once the repository variable `ARCOS_TESTNET_READY` is `true`; until then every deploy is of 4rc.OS alone.

1. **A pull request runs CI** ([ci.yml](../.github/workflows/ci.yml)): typecheck, lint, the tests (those of the deploy
   scripts, and a check of the deploy workflow's rules, included), the web build, the ABI drift check and `npm audit`.
   Nothing is deployed from a pull request. The root audit runs through `scripts/audit.mjs`: it fails on every high or
   critical finding except those whose advisories are listed in `scripts/audit-allowlist.json`, each by GHSA id, with
   the package it is about, a reason and an `until` date after which the entry no longer counts; an allowlisted package
   must also be a devDependency only (`npm ls --omit=dev <package>` finds no path to it), or the finding fails anyway.
   The allowlist is for advisories with no published fix, which an `overrides` entry in package.json cannot settle; the
   step prints each allowance with its reason. The audits of `tools/firebase` and `functions/deploy` have no allowlist.
2. **Merging into `main` starts the Deploy workflow** ([deploy.yml](../.github/workflows/deploy.yml)). A small `plan`
   job first chooses the sites (step 5); it checks nothing out and holds no token. Then two jobs run side by side. They
   install the project's dependencies and run its build, which is third-party code, so they hold no Google Cloud
   credential and no secret. `checks` runs the same CI again on the merged commit. `bundle` builds one bundle per site
   the run deploys, side by side: the mainnet one with the public values in
   [apps/web/apphosting.yaml](../apps/web/apphosting.yaml), the testnet one with
   [apps/web/apphosting.testnet.yaml](../apps/web/apphosting.testnet.yaml) merged over it, as App Hosting merges it
   (`scripts/apphosting-env.mjs --environment testnet`), so neither can drift from its site. Each checks that its
   settings name its own network, and keeps its build output for one day as an artifact. The owner decides when to
   merge; auto-merge is not used.
3. **The `production` environment waits for the owner's approval.** The `deploy` job belongs to a GitHub environment
   named `production`, which names a required reviewer and accepts the `main` branch only. It starts once `checks` and
   its bundles have passed, and then sits at "Waiting" until the reviewer approves it; no Google Cloud credential exists
   until then. Rejecting a run skips that deploy. Every merge asks, including one that only changes docs. Runs queue one
   behind another (a newer waiting run replaces an older waiting one), and a deploy that has started is not cancelled.
   Approve within a day: the bundles are kept for one day, so an approval given later fails at the download and the
   workflow has to be re-run (all jobs).
4. **The deploy, then the smoke checks.** The `deploy` job holds the credential, so it runs none of the project's
   dependencies and none of its build. After approval it:
   - downloads each bundle as data, by name, into a temporary folder outside the workspace (the Firebase CLI uploads the
     workspace as the source);
   - scans the bundles (`scripts/scan-bundle.mjs`, taken from this job's own checkout and needing no dependencies) for a
     list of forbidden strings kept in a secret, and stops on any match, or if the list is missing or empty. Because App
     Hosting builds the site again from the uploaded source, the scan covers a build of the same commit, lockfile and
     settings, not the running files themselves;
   - signs in with Workload Identity Federation: GitHub's short-lived token for this repository's `production`
     environment is exchanged for short-lived access as a service account that can do only what a source deploy needs;
   - installs the Firebase CLI from its lockfile (`tools/firebase`: one exact version, every package in its tree
     locked with an integrity hash, install scripts off) and runs `firebase deploy --only apphosting:arcos` with it. The
     CLI uploads the source, App Hosting builds it and rolls it out, and the CLI waits until the rollout has finished;
   - then, only once that has succeeded, reads the environment name of `arcos-testnet` (it must be `testnet`, or App
     Hosting would build it from `apphosting.yaml` alone, as a copy of 4rc.OS) and runs
     `firebase deploy --only apphosting:arcos-testnet` the same way.

   A separate `smoke` job, with no credentials, then calls 4rc.OS (`scripts/smoke.mjs`) whenever its deploy succeeded,
   even if the testnet deploy after it failed: `/` answers 200, `/api/pulse` answers 200 with 1,024 ratios, and
   `/api/approvals` answers 200 with at least one row. It retries for
   about two minutes, since a fresh rollout can take a moment. A failed smoke check means the new version is already
   live, so confirm the failure by hand before rolling back: open the site and the two routes in a browser. The
   approvals check reads the allowances of Multicall3, a public contract that anyone can change, so that check can fail
   while the deploy is fine. If the failure is real, roll back (below).
5. **Which sites, and what a failure stops.** A push to `main` deploys both. A manual run (Actions, Deploy, Run workflow)
   can pick `targets`: `both` (the default), `mainnet` or `testnet`; it builds, scans and deploys only those. The
   testnet site is gated by the repository variable `ARCOS_TESTNET_READY`:
   - While it is not exactly `true` (unset included), a push builds, scans and deploys 4rc.OS alone; the testnet bundle
     isn't built, and the run shows a notice saying so. A manual run with `targets: both` or `testnet` fails at once in
     `plan`, before anything is built or approved, and says to run again with `targets: mainnet`. It fails rather than
     quietly dropping the testnet site, so a manual run never deploys less than it was asked to.
   - Once it is `true`, both legs run as described here.

   The same run can also deploy the functions (`arcosIndexer`), after the sites. They are gated the same way, by
   `ARCOS_FUNCTIONS_READY`, and `targets: functions` deploys them alone ([OPERATIONS.md](OPERATIONS.md#deploying)). A
   manual run of the sites never deploys them. The workflow never deploys the Firestore indexes or rules: the pinned
   CLI compiles the rules through the Rules API even for `--only firestore:indexes`, and the deployer has no rules
   permission, on purpose. The owner deploys both by hand with `firebase deploy --only firestore:arcos`, as in the
   Firestore foundation's steps ([OPERATIONS.md](OPERATIONS.md#deploying)).

   The order keeps the testnet site from breaking 4rc.OS:
   - A bundle that fails to build, either one, stops the run before approval, and nothing is deployed. To ship 4rc.OS
     while the testnet build is broken, run the workflow with `targets: mainnet`.
   - 4rc.OS deploys first. If its deploy fails, the testnet deploy doesn't start.
   - If the testnet deploy fails (or its environment name check does), 4rc.OS is already live and its smoke checks still
     run; the run is marked failed for the testnet site only. Fix it and start a new manual run with
     `targets: testnet`; "Re-run failed jobs" would re-run the whole deploy job, 4rc.OS included. The first time a
     testnet deploy fails, check that the smoke job still ran: it reads an output of the deploy job, which GitHub is
     expected to publish from a failed job too.
   The testnet site has no smoke job: `scripts/smoke.mjs` reads mainnet data. After a testnet deploy, open
   https://testnet.4rcos.com (the menu bar shows "Testnet") and check that
   `curl -sI https://testnet.4rcos.com | grep -i x-robots-tag` answers `noindex, nofollow`.
6. **A dry run, and rolling back.**
   - *Dry run:* Actions, Deploy, Run workflow, tick `dry_run`. It runs the checks and the bundle build, scans and signs
     in, then lists the App Hosting backends and stops. Approval is still needed. Use it after changing anything in the
     setup below. It proves the sign-in and the read access to App Hosting; the upload to Cloud Storage is first
     exercised by a real deploy. Its table should list `arcos`, and `arcos-testnet` once that backend exists. Until
     `ARCOS_TESTNET_READY` is `true`, pick `targets: mainnet` for a dry run, or it fails in `plan`.
   - *Rolling back:* in the Firebase console open App Hosting, the `arcos` backend (or `arcos-testnet`), its Rollouts
     tab, and choose "Roll back to this build" on an earlier build. This is instant and does not rebuild. To go back
     in git as well, revert the commit and merge the revert; that goes through the same approval.

## What the setup holds

- **The `production` environment** (repository settings, Environments): a required reviewer, deployment branches limited
  to `main`, administrator bypass off, and "prevent self-review" off (one maintainer both merges and approves).
- **Repository variables** `GCP_WIF_PROVIDER` and `GCP_DEPLOY_SA`: the identity provider's resource name and the service
  account's address. They identify things; they are not secrets.
- **The secret `BUNDLE_DENY_PATTERNS`**: one regular expression per line, matched without regard to case and written
  plainly, without slashes around it (as in `/expression/i`) or quotes. The scan stops on a line written that way, since
  it would look for the slashes or quotes too and find nothing, and on a line that is not a valid expression. The list
  is not in the repository.
- **The Firebase CLI** (`tools/firebase`): a private package that names the CLI at one exact version, and its
  `package-lock.json`, which locks the CLI's whole dependency tree. The CLI ships no lockfile of its own, and it is the
  code that runs with the deploy credential. The folder is not an npm workspace of the repo root (the root workspaces
  are `apps/*` and `packages/*`), so the root install never installs it, and its `node_modules` stays out of the source
  the deploy uploads (`firebase.json` and `.gitignore` both leave out `node_modules`). To bump it, change `package.json`
  and regenerate the lockfile with npm 11.19.1: in that folder run `npm install --package-lock-only --ignore-scripts`,
  again until the file stops changing. The deploy job installs it with Node 22's bundled npm 10, so also check that
  `npm ci --ignore-scripts --prefix tools/firebase` works with npm 10. Then run `npm audit --prefix tools/firebase`, read the CLI's release notes, and
  run a dry run before the next real deploy. The same CLI runs `@arcos/data`'s tests: its unit tests load the CLI's
  deploy code (ci.yml) and its emulator suite starts the Firestore emulator with it (emulator.yml), so a bump must pass
  both, `npm test -w @arcos/data` and `npm run test:emulator -w @arcos/data`. Also change the version in the
  `functions:artifacts:setpolicy` command of [OPERATIONS.md](OPERATIONS.md#setting-it-up) (a test in
  `scripts/deploy-workflow.test.mjs` checks the two match).
- **Google Cloud**: a workload identity provider that accepts tokens only from this repository's `production`
  environment, and a deployer service account with App Hosting Developer, Service Usage Consumer and Storage Bucket
  Viewer on the project, and Storage Object Creator on the bucket that holds uploaded source. It has no key. The same
  roles cover both backends (see [The testnet site](#the-testnet-site)). The functions need more roles,
  listed in [OPERATIONS.md](OPERATIONS.md#setting-it-up).
- **Two App Hosting backends** in `europe-west4`, both listed in `firebase.json` with the root `apps/web`: `arcos`
  (https://4rcos.com), which runs as `arcos-web@` and has no environment name, so it reads `apphosting.yaml` alone; and
  `arcos-testnet` (https://testnet.4rcos.com), which runs as `arcos-testnet-web@` and has the environment name
  `testnet`.

The workflow never writes a credential into the repository. The sign-in step leaves a credentials file in the workspace,
which the deploy would upload with the source, so `.gitignore` lists `gha-creds-*.json` and the job fails if it doesn't.

## The testnet site

https://testnet.4rcos.com is the same code built for Arc Testnet, on a backend of its own, `arcos-testnet`. It is where
an app that needs one of 4rc.OS's own contracts (Vault and Vesting, later Pro) goes live first: the app registry
(`apps/web/src/apps/registry.ts`) lists such an app live only on a network where `ARCOS` in `@arcos/chain` names its
contract, and its grey "work in progress" window elsewhere. No such contract has a mainnet address before the audit
gates, so 4rc.OS never lists one early. The site shows a "Testnet" badge beside the brand and tells search engines to
leave it out: `robots` metadata and an `X-Robots-Tag: noindex, nofollow` header on every answer. It has no robots.txt
rule, since a crawler kept out by one never reads the noindex. A mainnet build has none of these.

### How its settings are made

App Hosting reads `apphosting.<environment name>.yaml` from the app's root and merges it over `apphosting.yaml` at build
time, the environment's values winning ([Firebase: multiple environments](https://firebase.google.com/docs/app-hosting/multiple-environments);
the merge is `MergeEnvVars` in App Hosting's buildpack, `GoogleCloudPlatform/buildpacks`, `pkg/firebase/apphostingschema`).
An `env` item of the environment's file replaces the base item of the same variable whole (value or secret, and
availability); base items it doesn't name are kept; `runConfig` is merged key by key. A backend without an environment
name reads `apphosting.yaml` alone. So `apps/web/apphosting.testnet.yaml` names only what differs:

- `NEXT_PUBLIC_ARC_NETWORK` `testnet` and `NEXT_PUBLIC_SITE_URL` `https://testnet.4rcos.com` (the WalletConnect
  metadata's url and icon come from the site URL);
- `NEXT_PUBLIC_FEE_RECIPIENT` `none`: a merge can't remove an item and App Hosting refuses an empty value, so the word
  stands for "no fee recipient", and Swap and Bridge charge no platform fee;
- `BLOCKSCOUT_API_KEY` `none`, a plain runtime value in place of the mainnet secret, so the backend's account needs
  access to no secret. The server then reads the testnet explorer's public API, which answers servers (the mainnet one
  refuses them).

The WalletConnect project ID and `runConfig` are the base file's. `scripts/apphosting-env.mjs --environment testnet`
merges the files the same way for the workflow's testnet bundle, and fails if `apphosting.testnet.yaml` is missing.

### Owner steps

Once. Until the last step sets the repository variable `ARCOS_TESTNET_READY` to `true`, the workflow deploys 4rc.OS
alone and never touches `arcos-testnet`, so these steps can be done at any pace. Set the variable only after the backend
exists with the environment name `testnet` (steps 2 and 3): from then on every deploy of `main` deploys the testnet site
too, and fails at its environment name check if that name is wrong. Run them from a machine signed in as the owner
(`gcloud auth login`, `firebase login`):

```sh
export PROJECT_ID=arcos-c80cf
export TESTNET_SA="arcos-testnet-web@${PROJECT_ID}.iam.gserviceaccount.com"
```

1. **The service account the testnet site runs as.** It gets App Hosting's runtime role and nothing else: no
   Firestore, no secret.

   ```sh
   gcloud iam service-accounts create arcos-testnet-web --project="$PROJECT_ID" \
     --display-name="4rc.OS testnet site (App Hosting arcos-testnet)"
   gcloud projects add-iam-policy-binding "$PROJECT_ID" \
     --member="serviceAccount:${TESTNET_SA}" --role=roles/firebaseapphosting.computeRunner --condition=None
   ```

2. **The backend.** `--non-interactive` makes it a backend deployed from source, like `arcos`: in interactive mode the
   CLI links a GitHub repository instead. Without `--app` it creates a new Firebase web app named after the backend
   (with a suffix if the name is taken); add `--app <the web app ID of arcos>` to share that one instead.

   ```sh
   firebase apphosting:backends:create --backend arcos-testnet --primary-region europe-west4 --root-dir apps/web \
     --service-account "$TESTNET_SA" --project "$PROJECT_ID" --non-interactive
   ```

3. **Its environment name, `testnet`.** Firebase console, App Hosting, `arcos-testnet`, Settings, Environment,
   Environment name: `testnet`, Save. Check it (the deploy workflow reads the same field before each testnet deploy):

   ```sh
   firebase apphosting:backends:get arcos-testnet --project "$PROJECT_ID" --json | jq -r '.result.environment'
   ```

   It must print `testnet`. `arcos` keeps no environment name.

4. **The domain.** Firebase console, App Hosting, `arcos-testnet`, Settings, Domains, Add custom domain:
   `testnet.4rcos.com`. Add the DNS records the console shows at the DNS provider of `4rcos.com`, and wait until the
   console shows the domain connected and its certificate issued.

5. **WalletConnect.** In the Reown dashboard (cloud.reown.com), the project whose ID is in `apps/web/apphosting.yaml`,
   add `https://testnet.4rcos.com` to the domain allowlist, beside `https://4rcos.com`. Without it, phones can't pair on
   the testnet site.

6. **The deployer.** Nothing to grant, and here is why. `arcos-deployer@` holds App Hosting Developer, Service Usage
   Consumer and Storage Bucket Viewer on the project, so they cover a second backend. Its fourth role, Storage Object
   Creator, is on one bucket only. The CLI uploads each backend's source to `firebaseapphosting-sources-<project
   number>-<region>` (firebase-tools, `deploy/apphosting/deploy.js`): one bucket per project and region, not per
   backend. Both backends are in `europe-west4`, so they share the bucket that role is on. To see it:

   ```sh
   PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
   gcloud storage buckets get-iam-policy "gs://firebaseapphosting-sources-${PROJECT_NUMBER}-europe-west4" \
     --format=json | jq '.bindings[] | select(.role == "roles/storage.objectCreator")'
   ```

   It should list `arcos-deployer@`. If the `actAs` fallback was ever granted to the deployer on `arcos-web@`, a testnet
   deploy may need the same on `arcos-testnet-web@`. Grant it only if the testnet deploy fails with
   `iam.serviceAccounts.actAs` denied for that account:

   ```sh
   gcloud iam service-accounts add-iam-policy-binding "$TESTNET_SA" --project="$PROJECT_ID" \
     --member="serviceAccount:arcos-deployer@${PROJECT_ID}.iam.gserviceaccount.com" --role=roles/iam.serviceAccountUser
   ```

7. **Turn the testnet deploy on.** A dry run first (Actions, Deploy, Run workflow, `targets: mainnet`, `dry_run`)
   should list both backends. Then set the repository variable, in a clone of this repository with `gh` signed in as
   the owner:

   ```sh
   gh variable set ARCOS_TESTNET_READY --body true
   ```

   or on GitHub: Settings, Secrets and variables, Actions, the Variables tab, New repository variable, name
   `ARCOS_TESTNET_READY`, value `true`. The value must be exactly `true`, lower case.

8. **The first deploy.** Start a manual run with `targets: testnet` (or merge into `main` for both), approve it, and
   check the testnet site as in step 5 of the deploy above. To turn the testnet deploy off again, delete the variable
   (`gh variable delete ARCOS_TESTNET_READY`) or set it to anything but `true`.
