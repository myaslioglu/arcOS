# Deploying

How a change reaches https://4rcos.com. A deploy runs from GitHub Actions, signs in to Google Cloud without a key
file, and starts only after the checks pass and the owner approves it.

1. **A pull request runs CI** ([ci.yml](../.github/workflows/ci.yml)): typecheck, lint, the tests (those of the deploy
   scripts, and a check of the deploy workflow's rules, included), the web build, the ABI drift check and `npm audit`.
   Nothing is deployed from a pull request.
2. **Merging into `main` starts the Deploy workflow** ([deploy.yml](../.github/workflows/deploy.yml)). Two jobs run side
   by side. They install the project's dependencies and run its build, which is third-party code, so they hold no Google
   Cloud credential and no secret. `checks` runs the same CI again on the merged commit. `bundle` builds a mainnet
   bundle with the public values in [apps/web/apphosting.yaml](../apps/web/apphosting.yaml), read from that file by
   `scripts/apphosting-env.mjs` so the two can't drift, and keeps the build output for one day as an artifact. The owner
   decides when to merge; auto-merge is not used.
3. **The `production` environment waits for the owner's approval.** The `deploy` job belongs to a GitHub environment
   named `production`, which names a required reviewer and accepts the `main` branch only. It starts once `checks` and
   `bundle` have passed, and then sits at "Waiting" until the reviewer approves it; no Google Cloud credential exists
   until then. Rejecting a run skips that deploy. Every merge asks, including one that only changes docs. Runs queue one
   behind another (a newer waiting run replaces an older waiting one), and a deploy that has started is not cancelled.
   Approve within a day: the bundle is kept for one day, so an approval given later fails at the download and the
   workflow has to be re-run (all jobs).
4. **The deploy, then the smoke checks.** The `deploy` job holds the credential, so it runs none of the project's
   dependencies and none of its build. After approval it:
   - downloads the bundle as data, into a temporary folder outside the workspace (the Firebase CLI uploads the
     workspace as the source);
   - scans the bundle (`scripts/scan-bundle.mjs`, taken from this job's own checkout and needing no dependencies) for a
     list of forbidden strings kept in a secret, and stops on any match, or if the list is missing or empty. Because App
     Hosting builds the site again from the uploaded source, the scan covers a build of the same commit, lockfile and
     settings, not the running files themselves;
   - signs in with Workload Identity Federation: GitHub's short-lived token for this repository's `production`
     environment is exchanged for short-lived access as a service account that can do only what a source deploy needs;
   - installs the Firebase CLI from its lockfile (`tools/firebase`: one exact version, every package in its tree
     locked with an integrity hash, install scripts off) and runs `firebase deploy --only apphosting:arcos` with it. The
     CLI uploads the source, App Hosting builds it and rolls it out, and the CLI waits until the rollout has finished.

   A separate `smoke` job, with no credentials, then calls the live site (`scripts/smoke.mjs`): `/` answers 200,
   `/api/pulse` answers 200 with 1,024 ratios, and `/api/approvals` answers 200 with at least one row. It retries for
   about two minutes, since a fresh rollout can take a moment. A failed smoke check means the new version is already
   live, so confirm the failure by hand before rolling back: open the site and the two routes in a browser. The
   approvals check reads the allowances of Multicall3, a public contract that anyone can change, so that check can fail
   while the deploy is fine. If the failure is real, roll back (below).
5. **A dry run, and rolling back.**
   - *Dry run:* Actions, Deploy, Run workflow, tick `dry_run`. It runs the checks and the bundle build, scans and signs
     in, then lists the App Hosting backends and stops. Approval is still needed. Use it after changing anything in the
     setup below. It proves the sign-in and the read access to App Hosting; the upload to Cloud Storage is first
     exercised by a real deploy.
   - *Rolling back:* in the Firebase console open App Hosting, the `arcos` backend, its Rollouts tab, and choose "Roll
     back to this build" on an earlier build. This is instant and does not rebuild. To go back in git as well, revert the
     commit and merge the revert; that goes through the same approval.

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
  again until the file stops changing. Then run `npm audit --prefix tools/firebase`, read the CLI's release notes, and
  run a dry run before the next real deploy.
- **Google Cloud**: a workload identity provider that accepts tokens only from this repository's `production`
  environment, and a deployer service account with App Hosting Developer, Service Usage Consumer and Storage Bucket
  Viewer on the project, and Storage Object Creator on the bucket that holds uploaded source. It has no key.

The workflow never writes a credential into the repository. The sign-in step leaves a credentials file in the workspace,
which the deploy would upload with the source, so `.gitignore` lists `gha-creds-*.json` and the job fails if it doesn't.
