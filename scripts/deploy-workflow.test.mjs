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

/** The steps of one job, each as its text from its "- " line to the next step's. */
function steps(name) {
  const text = job(name);
  const start = text.search(/^ {4}steps:\s*$/m);
  expect(start, `job ${name} has steps`).toBeGreaterThanOrEqual(0);
  return text
    .slice(start)
    .split("\n")
    .slice(1)
    .join("\n")
    .split(/^(?= {6}- )/m)
    .filter((step) => step.trim() !== "");
}

describe("deploy.yml", () => {
  it("calls ci.yml as its checks, and ci.yml can be called", () => {
    expect(deploy).toMatch(/^  checks:\n    uses: \.\/\.github\/workflows\/ci\.yml$/m);
    expect(ci).toMatch(/^  workflow_call:\s*$/m);
    expect(job("deploy")).toMatch(/^ {4}needs: \[checks, bundle\]$/m);
    expect(job("smoke")).toMatch(/^ {4}needs: deploy$/m);
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
    expect(deploy.match(/^ {4}environment:/gm)).toHaveLength(1); // the bundle and smoke jobs have none, so neither is a second way in
    expect(job("bundle")).not.toMatch(/environment/);
    expect(job("deploy")).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  });

  it("gives only the deploy job a token to sign in with", () => {
    expect(deploy.match(/id-token:\s*write/g)).toHaveLength(1);
    expect(job("deploy")).toMatch(/id-token:\s*write/);
    expect(job("bundle")).not.toMatch(/id-token/);
    expect(job("smoke")).not.toMatch(/id-token/);
    expect(deploy).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("signs in without a key file or key secret", () => {
    expect(deploy).not.toMatch(/credentials_json/);
    expect(deploy).toMatch(/workload_identity_provider: \$\{\{ vars\.GCP_WIF_PROVIDER \}\}/);
    expect(deploy).toMatch(/service_account: \$\{\{ vars\.GCP_DEPLOY_SA \}\}/);
    expect(deploy).not.toMatch(/secrets: inherit/);
  });

  it("pins every third-party action to a commit, and keeps first-party ones on a major tag", () => {
    const uses = [...deploy.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(3);
    for (const ref of uses) {
      if (ref.startsWith("./")) continue;
      if (ref.startsWith("actions/")) {
        expect(ref, `${ref} is on a major tag`).toMatch(/^actions\/[\w-]+@v\d+$/);
        continue;
      }
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

  describe("keeps third-party code away from the production credential", () => {
    it("builds in a job of its own, beside the checks, with no credential of any kind", () => {
      const text = job("bundle");
      expect(text).not.toMatch(/^ {4}needs:/m);
      expect(text).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}steps:/m); // that permission alone
      expect(text).not.toMatch(/secrets\.|vars\.|GITHUB_TOKEN|google-github-actions|GOOGLE_|firebase/);
      expect(text).toMatch(/persist-credentials: false/);
      expect(text).toMatch(/run: npm ci$/m);
      expect(text).toMatch(/run: npm run build -w @arcos\/web$/m);
    });

    it("runs no project code in the deploy job: no install of the repo, no build, no repo script but the scan", () => {
      const text = job("deploy");
      expect(text).not.toMatch(/npm run|next build|apphosting-env/);
      for (const line of text.split("\n").filter((l) => /\bnpm (ci|install)\b/.test(l))) {
        expect(line, "an install in the deploy job is of the CLI's own folder only").toMatch(/--prefix \.github\/deploy-tools/);
      }
      const commands = text.split("\n").filter((l) => /^\s*(?:- )?run:/.test(l));
      const scripts = commands.flatMap((l) => [...l.matchAll(/\bnode (\S+)/g)].map((m) => m[1].replace(/"/g, "")));
      expect(scripts).toEqual(["scripts/scan-bundle.mjs"]);
    });

    it("hands the bundle over as data, through an artifact that holds build output only", () => {
      const up = steps("bundle").find((s) => /actions\/upload-artifact@/.test(s));
      const down = steps("deploy").find((s) => /actions\/download-artifact@/.test(s));
      expect(up, "the bundle job uploads").toBeDefined();
      expect(down, "the deploy job downloads").toBeDefined();
      expect(up).toMatch(/apps\/web\/\.next\/static\n/);
      expect(up).toMatch(/apps\/web\/\.next\/server\n/);
      expect(up).not.toMatch(/scripts|\.github/); // scripts/ always comes from the deploy job's own checkout
      expect(up).toMatch(/retention-days: 1$/m);
      expect(up).toMatch(/if-no-files-found: error/);
      expect(up).toMatch(/include-hidden-files: true/); // the scan must see every file the build made
      expect(up.match(/^ {10}name: (\S+)$/m)?.[1]).toBe("bundle"); // the artifact's name, not the step's
      expect(down.match(/^ {10}name: (\S+)$/m)?.[1]).toBe("bundle");
    });

    it("downloads the bundle outside the workspace, which the CLI uploads as source", () => {
      const down = steps("deploy").find((s) => /actions\/download-artifact@/.test(s));
      expect(down).toMatch(/path: \$\{\{ runner\.temp \}\}\/bundle$/m);
      expect(job("deploy")).toMatch(/node scripts\/scan-bundle\.mjs "\$RUNNER_TEMP\/bundle\/static" "\$RUNNER_TEMP\/bundle\/server"$/m);
    });

    it("gives the patterns to the scan step and to no other", () => {
      expect(deploy.match(/\$\{\{\s*secrets\./g)).toHaveLength(1);
      const holders = steps("deploy").filter((s) => /\$\{\{\s*secrets\./.test(s));
      expect(holders).toHaveLength(1);
      expect(holders[0]).toMatch(/BUNDLE_DENY_PATTERNS: \$\{\{ secrets\.BUNDLE_DENY_PATTERNS \}\}/);
      expect(holders[0]).toMatch(/scripts\/scan-bundle\.mjs/);
    });

    it("needs nothing installed to scan: the scan script imports only what node ships", () => {
      const source = read("scripts/scan-bundle.mjs");
      const specifiers = [...source.matchAll(/(?:\bfrom\s+|\bimport\(\s*|\brequire\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) expect(specifier, `${specifier} is a node built-in`).toMatch(/^node:/);
    });
  });

  it("checks out, downloads and scans before signing in, and deploys last", () => {
    const text = job("deploy");
    const at = (needle) => text.indexOf(needle); // needles are the lines that act, so a comment naming a step can't match
    expect(at("uses: actions/checkout@")).toBeGreaterThanOrEqual(0);
    expect(at("uses: actions/download-artifact@")).toBeGreaterThan(at("uses: actions/checkout@"));
    expect(at("run: node scripts/scan-bundle.mjs")).toBeGreaterThan(at("uses: actions/download-artifact@"));
    expect(at("uses: google-github-actions/auth@")).toBeGreaterThan(at("run: node scripts/scan-bundle.mjs"));
    expect(at("run: git check-ignore")).toBeGreaterThan(at("uses: google-github-actions/auth@"));
    expect(at("deploy --only")).toBeGreaterThan(at("run: git check-ignore"));
    expect(text).toMatch(/BUNDLE_DENY_PATTERNS: \$\{\{ secrets\.BUNDLE_DENY_PATTERNS \}\}/);
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
