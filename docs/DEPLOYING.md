# Deploying

How a change reaches https://4rcos.com. A deploy runs from GitHub Actions, signs in to Google Cloud without a key
file, and starts only after the checks pass and the owner approves it.

1. **A pull request runs CI** ([ci.yml](../.github/workflows/ci.yml)): typecheck, lint, the tests (those of the deploy
   scripts, and a check of the deploy workflow's rules, included), the web build, the ABI drift check and `npm audit`.
   Nothing is deployed from a pull request.
2. **Merging into `main` starts the Deploy workflow** ([deploy.yml](../.github/workflows/deploy.yml)). Its first job
   runs the same CI again on the merged commit. The owner decides when to merge; auto-merge is not used.
3. **The `production` environment waits for the owner's approval.** The `deploy` job belongs to a GitHub environment
   named `production`, which names a required reviewer and accepts the `main` branch only. The run sits at "Waiting"
   until the reviewer approves it, and no Google Cloud credential exists until then. Rejecting a run skips that
   deploy. Every merge asks, including one that only changes docs. Runs queue one behind another (a newer waiting run
   replaces an older waiting one), and a deploy that has started is not cancelled.
4. **The deploy, then the smoke checks.** After approval the job:
   - builds a mainnet bundle with the public values in [apps/web/apphosting.yaml](../apps/web/apphosting.yaml), read
     from that file by `scripts/apphosting-env.mjs` so the two can't drift;
   - scans the bundle (`scripts/scan-bundle.mjs`) for a list of forbidden strings kept in a secret, and stops on any
     match, or if the list is missing or empty. Because App Hosting builds the site again from the uploaded source,
     the scan covers a build of the same commit, lockfile and settings, not the running files themselves;
   - signs in with Workload Identity Federation: GitHub's short-lived token for this repository's `production`
     environment is exchanged for short-lived access as a service account that can do only what a source deploy needs;
   - runs `firebase deploy --only apphosting:arcos` with a pinned Firebase CLI. The CLI uploads the source, App Hosting
     builds it and rolls it out, and the CLI waits until the rollout has finished.

   A separate `smoke` job, with no credentials, then calls the live site (`scripts/smoke.mjs`): `/` answers 200,
   `/api/pulse` answers 200 with 1,024 ratios, and `/api/approvals` answers 200 with at least one row. It retries for
   about two minutes, since a fresh rollout can take a moment. A failed smoke check means the new version is already
   live: roll it back (below).
5. **A dry run, and rolling back.**
   - *Dry run:* Actions, Deploy, Run workflow, tick `dry_run`. It runs the checks, builds, scans and signs in, then
     lists the App Hosting backends and stops. Approval is still needed. Use it after changing anything in the setup
     below.
   - *Rolling back:* in the Firebase console open App Hosting, the `arcos` backend, its Rollouts tab, and choose "Roll
     back to this build" on an earlier build. This is instant and does not rebuild. To go back in git as well, revert the
     commit and merge the revert; that goes through the same approval.

## What the setup holds

- **The `production` environment** (repository settings, Environments): a required reviewer, deployment branches limited
  to `main`, administrator bypass off, and "prevent self-review" off (one maintainer both merges and approves).
- **Repository variables** `GCP_WIF_PROVIDER` and `GCP_DEPLOY_SA`: the identity provider's resource name and the service
  account's address. They identify things; they are not secrets.
- **The secret `BUNDLE_DENY_PATTERNS`**: one regular expression per line, matched without regard to case. The list is not
  in the repository.
- **Google Cloud**: a workload identity provider that accepts tokens only from this repository's `production`
  environment, and a deployer service account with App Hosting Developer, Service Usage Consumer and Storage Bucket
  Viewer on the project, and Storage Object Creator on the bucket that holds uploaded source. It has no key.

The workflow never writes a credential into the repository. The sign-in step leaves a credentials file in the workspace,
which the deploy would upload with the source, so `.gitignore` lists `gha-creds-*.json` and the job fails if it doesn't.
