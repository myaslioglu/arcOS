// The owner's rules for deploying, as checks on the workflow files. They read the YAML as text, so they are blunt on
// purpose: each pins something the setup outside the repo depends on, or something a reviewer could miss in a diff.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const deploy = read(".github/workflows/deploy.yml");
const ci = read(".github/workflows/ci.yml");

/** The text of one top-level job of deploy.yml, from its key to the next job's key. */
function job(name) {
  const start = deploy.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  expect(start, `job ${name} exists`).toBeGreaterThanOrEqual(0);
  const rest = deploy.slice(start + 1);
  const next = rest.search(/^  [a-z][a-z-]*:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("deploy.yml", () => {
  it("calls ci.yml as its checks, and ci.yml can be called", () => {
    expect(deploy).toMatch(/^  checks:\n    uses: \.\/\.github\/workflows\/ci\.yml$/m);
    expect(ci).toMatch(/^  workflow_call:\s*$/m);
    expect(job("deploy")).toMatch(/^    needs: checks$/m);
    expect(job("smoke")).toMatch(/^    needs: deploy$/m);
  });

  it("starts only from a push to main or a manual run, never from a pull request", () => {
    const triggers = deploy.slice(deploy.indexOf("\non:"), deploy.indexOf("\nconcurrency:"));
    expect(triggers).toMatch(/push:\n {4}branches: \[main\]/);
    expect(triggers).toMatch(/workflow_dispatch:/);
    expect(triggers).toMatch(/dry_run:[\s\S]*type: boolean[\s\S]*default: false/);
    expect(deploy).not.toMatch(/pull_request/); // covers pull_request_target too
  });

  it("waits in the production environment, which the Google Cloud condition and the approval rule both name", () => {
    expect(job("deploy")).toMatch(/^ {4}environment:\n {6}name: production\n {6}url: https:\/\/4rcos\.com$/m);
    expect(deploy.match(/^ {4}environment:/gm)).toHaveLength(1); // the smoke job has none, so it can't be a second way in
  });

  it("gives only the deploy job a token to sign in with", () => {
    expect(deploy.match(/id-token:\s*write/g)).toHaveLength(1);
    expect(job("deploy")).toMatch(/id-token:\s*write/);
    expect(job("smoke")).not.toMatch(/id-token/);
    expect(deploy).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("signs in without a key file or key secret", () => {
    expect(deploy).not.toMatch(/credentials_json/);
    expect(deploy).toMatch(/workload_identity_provider: \$\{\{ vars\.GCP_WIF_PROVIDER \}\}/);
    expect(deploy).toMatch(/service_account: \$\{\{ vars\.GCP_DEPLOY_SA \}\}/);
    expect(deploy).not.toMatch(/secrets: inherit/);
  });

  it("pins every third-party action to a commit, and keeps first-party ones on a tag", () => {
    const uses = [...deploy.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(3);
    for (const ref of uses) {
      if (ref.startsWith("./") || ref.startsWith("actions/")) continue;
      expect(ref, `${ref} is pinned`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    expect(deploy).toMatch(/google-github-actions\/auth@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  });

  it("runs the Firebase CLI at an exact version, without prompts and without --force", () => {
    expect(deploy).toMatch(/^ {2}FIREBASE_TOOLS_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(deploy).toMatch(/npx --yes "firebase-tools@\$\{FIREBASE_TOOLS_VERSION\}" deploy --only "apphosting:\$\{APPHOSTING_BACKEND\}" --project "\$FIREBASE_PROJECT" --non-interactive$/m);
    expect(deploy).toMatch(/npx --yes "firebase-tools@\$\{FIREBASE_TOOLS_VERSION\}" apphosting:backends:list .*--non-interactive$/m);
    expect(deploy).not.toMatch(/(^|\s)--force\b(?!:)/m); // the comment that explains why not is allowed to name it
    expect(deploy.split("\n").filter((l) => /^\s*run:.*firebase-tools/.test(l) && /--force/.test(l))).toEqual([]);
  });

  it("scans the bundle before signing in, from a secret, and deploys after the scan", () => {
    const text = job("deploy");
    const at = (needle) => text.indexOf(needle);
    expect(at("scripts/scan-bundle.mjs")).toBeGreaterThan(at("npm run build"));
    expect(at("google-github-actions/auth@")).toBeGreaterThan(at("scripts/scan-bundle.mjs"));
    expect(at("deploy --only")).toBeGreaterThan(at("google-github-actions/auth@"));
    expect(text).toMatch(/BUNDLE_DENY_PATTERNS: \$\{\{ secrets\.BUNDLE_DENY_PATTERNS \}\}/);
    expect(deploy.match(/secrets\.BUNDLE_DENY_PATTERNS/g)).toHaveLength(1); // only the scan step gets the patterns
  });

  it("does one deploy at a time and never cancels one that has started", () => {
    expect(deploy).toMatch(/^concurrency:\n {2}group: deploy-production\n {2}cancel-in-progress: false$/m);
    expect(deploy).not.toMatch(/cancel-in-progress: true/);
  });

  it("skips the smoke job on a dry run and gives it no credentials", () => {
    const text = job("smoke");
    expect(text).toMatch(/if: \$\{\{ !inputs\.dry_run \}\}/);
    expect(text).not.toMatch(/google-github-actions|GOOGLE_|firebase-tools|secrets\./);
  });
});
