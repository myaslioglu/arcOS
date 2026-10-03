// The owner's rules for deploying, as checks on the workflow files. They read the YAML as text, so they are blunt on
// purpose: each pins something the setup outside the repo depends on, or something a reviewer could miss in a diff.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const deploy = read(".github/workflows/deploy.yml");
const ci = read(".github/workflows/ci.yml");
/** deploy.yml without its comment lines, for checks on what runs (a comment may name what it explains away). */
const deployCode = deploy
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** The text of one top-level job of a workflow (deploy.yml unless another is given), from its key to the next job's key. */
function job(name, workflow = deploy) {
  const start = workflow.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  expect(start, `job ${name} exists`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^  [a-z][a-z-]*:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The shell each `run:` of a text runs: a one-line run, or the lines of a `run: |` block (those indented deeper than
 * the key), joined.
 */
function runScripts(text) {
  const lines = text.split("\n");
  const scripts = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) return;
    if (m[2] !== "|") {
      scripts.push(m[2]);
      return;
    }
    const block = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > m[1].length); j += 1) block.push(lines[j].trim());
    while (block.at(-1) === "") block.pop();
    scripts.push(block.join("\n"));
  });
  return scripts;
}

/** The deploy job's `if:`, a folded block, as one line without the expression's braces. */
function deployCondition() {
  const m = job("deploy").match(/^ {4}if: >-\n((?: {6}.+\n)+)/m);
  expect(m, "the deploy job has a folded if").not.toBeNull();
  const text = m[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  expect(text).toMatch(/^\$\{\{ .* \}\}$/);
  return text.slice(4, -3);
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
    expect(job("deploy")).toMatch(/^ {4}needs: \[plan, checks, bundle, functions-bundle\]$/m);
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
    expect(job("bundle")).not.toMatch(/^\s*environment:/m);
    expect(job("functions-bundle")).not.toMatch(/^\s*environment:/m);
    expect(deployCondition()).toMatch(/^github\.ref == 'refs\/heads\/main' && /);
  });

  // A bundle job this run didn't need is skipped, and a skipped need would skip the deploy too; so the deploy job says
  // which results it accepts. Nothing else: a failed or cancelled check or bundle still stops it.
  it("deploys after skipped bundle jobs, never after a failed or cancelled one", () => {
    expect(deployCondition()).toBe(
      [
        "github.ref == 'refs/heads/main' && !cancelled() && needs.plan.result == 'success' && needs.checks.result == 'success'",
        "&& (needs.bundle.result == 'success' || needs.bundle.result == 'skipped')",
        "&& (needs.functions-bundle.result == 'success' || needs.functions-bundle.result == 'skipped')",
      ].join(" "),
    );
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

  it("never passes --force, which would skip a backend it can't find and still report success", () => {
    expect(deploy).not.toMatch(/(^|\s)--force\b(?!:)/m); // the comment that explains why not is allowed to name it
    expect(deploy.split("\n").filter((l) => /^\s*run:.*firebase/.test(l) && /--force/.test(l))).toEqual([]);
  });

  describe("keeps third-party code away from the production credential", () => {
    it("builds in a job of its own, beside the checks, with no credential of any kind", () => {
      const text = job("bundle");
      expect(text).toMatch(/^ {4}needs: plan$/m); // only the choice of sites, which runs no code of the project's
      expect(job("plan")).not.toMatch(/^ {4}needs:/m);
      expect(text).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}steps:/m); // that permission alone
      expect(text).not.toMatch(/secrets\.|vars\.|GITHUB_TOKEN|google-github-actions|GOOGLE_|firebase/);
      expect(text).toMatch(/persist-credentials: false/);
      expect(text).toMatch(/run: npm ci$/m);
      expect(text).toMatch(/run: npm run build -w @arcos\/web$/m);
    });

    it("restores no cache in the deploy job, so no earlier job's files can land next to the credential", () => {
      const text = job("deploy");
      expect(text).not.toMatch(/^\s*cache:/m);
      const setupNode = steps("deploy").filter((step) => /uses: actions\/setup-node@/.test(step));
      expect(setupNode.length).toBeGreaterThan(0);
      for (const step of setupNode) expect(step).toMatch(/package-manager-cache: false/);
    });

    it("runs no project code in the deploy job: no install of the repo, no build, no repo script but the scan", () => {
      const text = job("deploy");
      expect(text).not.toMatch(/npm run|next build|apphosting-env/);
      for (const line of text.split("\n").filter((l) => /\bnpm (ci|install)\b/.test(l))) {
        expect(line, "an install in the deploy job is of the CLI's own folder only").toMatch(/--prefix tools\/firebase/);
      }
      const scripts = runScripts(text).flatMap((l) => [...l.matchAll(/\bnode (\S+)/g)].map((m) => m[1].replace(/"/g, "")));
      expect(scripts).toEqual(["scripts/scan-bundle.mjs"]);
    });

    it("hands each bundle over as data, through an artifact that holds build output only", () => {
      const up = steps("bundle").find((s) => /actions\/upload-artifact@/.test(s));
      const downs = steps("deploy").filter((s) => /actions\/download-artifact@/.test(s));
      expect(up, "the bundle job uploads").toBeDefined();
      expect(downs, "the deploy job downloads one bundle per site, and the functions bundle").toHaveLength(3);
      expect(up).toMatch(/apps\/web\/\.next\/static\n/);
      expect(up).toMatch(/apps\/web\/\.next\/server\n/);
      expect(up).not.toMatch(/scripts|\.github/); // scripts/ always comes from the deploy job's own checkout
      expect(up).toMatch(/retention-days: 1$/m);
      expect(up).toMatch(/if-no-files-found: error/);
      expect(up).toMatch(/include-hidden-files: true/); // the scan must see every file the build made
      expect(up.match(/^ {10}name: (.+)$/m)?.[1]).toBe("bundle-${{ matrix.site }}"); // the artifact's name, not the step's
      // By name, never by pattern: a missing bundle fails its download rather than being skipped.
      expect(downs.map((d) => d.match(/^ {10}name: (.+)$/m)?.[1])).toEqual(["bundle-mainnet", "bundle-testnet", "bundle-functions"]);
      for (const d of downs) expect(d).not.toMatch(/pattern:/);
    });

    it("downloads each bundle outside the workspace, which the CLI uploads as source, and scans both halves of each", () => {
      const downs = steps("deploy").filter((s) => /actions\/download-artifact@/.test(s));
      expect(downs[0]).toMatch(/^ {8}if: env\.DEPLOY_MAINNET == 'true'$/m);
      expect(downs[0]).toMatch(/path: \$\{\{ runner\.temp \}\}\/bundle-mainnet$/m);
      expect(downs[1]).toMatch(/^ {8}if: env\.DEPLOY_TESTNET == 'true'$/m);
      expect(downs[1]).toMatch(/path: \$\{\{ runner\.temp \}\}\/bundle-testnet$/m);
      expect(downs[2]).toMatch(/^ {8}if: env\.DEPLOY_FUNCTIONS == 'true'$/m);
      expect(downs[2]).toMatch(/path: \$\{\{ runner\.temp \}\}\/bundle-functions$/m);
      const scan = runScripts(job("deploy")).find((r) => /scan-bundle/.test(r));
      expect(scan).toBe(
        [
          "dirs=()",
          'if [ "$DEPLOY_MAINNET" = true ]; then dirs+=("$RUNNER_TEMP/bundle-mainnet/static" "$RUNNER_TEMP/bundle-mainnet/server"); fi',
          'if [ "$DEPLOY_TESTNET" = true ]; then dirs+=("$RUNNER_TEMP/bundle-testnet/static" "$RUNNER_TEMP/bundle-testnet/server"); fi',
          'if [ "$DEPLOY_FUNCTIONS" = true ]; then dirs+=("$RUNNER_TEMP/bundle-functions"); fi',
          'if [ "${#dirs[@]}" -gt 0 ]; then node scripts/scan-bundle.mjs "${dirs[@]}"; fi',
        ].join("\n"),
      );
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
    expect(at("node scripts/scan-bundle.mjs")).toBeGreaterThan(text.lastIndexOf("uses: actions/download-artifact@"));
    expect(at("run: npm ci --ignore-scripts --prefix tools/firebase")).toBeGreaterThan(at("node scripts/scan-bundle.mjs"));
    expect(at("uses: google-github-actions/auth@")).toBeGreaterThan(at("run: npm ci --ignore-scripts --prefix tools/firebase"));
    expect(at("run: git check-ignore")).toBeGreaterThan(at("uses: google-github-actions/auth@"));
    expect(at("deploy --only")).toBeGreaterThan(at("run: git check-ignore"));
    expect(at('deploy --only "apphosting:${APPHOSTING_TESTNET_BACKEND}"')).toBeGreaterThan(at('deploy --only "apphosting:${APPHOSTING_BACKEND}"'));
    expect(text).toMatch(/BUNDLE_DENY_PATTERNS: \$\{\{ secrets\.BUNDLE_DENY_PATTERNS \}\}/);
  });

  it("does one deploy at a time and never cancels one that has started", () => {
    expect(deploy).toMatch(/^concurrency:\n {2}group: deploy-production\n {2}cancel-in-progress: false$/m);
    expect(deploy).not.toMatch(/cancel-in-progress: true/);
  });

  it("skips the smoke job on a dry run and gives it no credentials", () => {
    const text = job("smoke");
    expect(text).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && !inputs\.dry_run && needs\.deploy\.outputs\.mainnet == 'success' \}\}$/m);
    expect(text).not.toMatch(/google-github-actions|GOOGLE_|firebase-tools|secrets\./);
  });
});

// Both sites ship from one commit under one approval: 4rc.OS (backend arcos) first, the testnet site (arcos-testnet) only
// after it. The testnet deploy must never be able to break 4rc.OS's, or stop it in a way nobody chose.
describe("deploy.yml, the two sites", () => {
  const MATRIX = "${{ fromJSON(needs.plan.outputs.sites) }}";
  const deployStep = (id) => steps("deploy").find((s) => new RegExp(`^ {8}id: ${id}$`, "m").test(s));

  it("lets a manual run pick the sites, both by default; a push has no input (plan decides)", () => {
    const triggers = deploy.slice(deploy.indexOf("\non:"), deploy.indexOf("\nconcurrency:"));
    expect(triggers).toMatch(
      / {6}targets:\n {8}description: .+\n {8}type: choice\n {8}options:\n {10}- both\n {10}- mainnet\n {10}- testnet\n {10}- functions\n {8}default: both\n/,
    );
  });

  it("names the testnet backend as firebase.json does", () => {
    expect(deploy).toMatch(/^ {2}APPHOSTING_BACKEND: arcos$/m);
    expect(deploy).toMatch(/^ {2}APPHOSTING_TESTNET_BACKEND: arcos-testnet$/m);
    expect(JSON.parse(read("firebase.json")).apphosting.map((e) => e.backendId)).toEqual(["arcos", "arcos-testnet"]);
  });

  it("builds one bundle per chosen site, and lets neither build cancel the other", () => {
    const text = job("bundle");
    expect(text).toMatch(/^ {4}strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}site: (.+)$/m);
    expect(text.match(/^ {8}site: (.+)$/m)?.[1]).toBe(MATRIX);
  });

  it("deploys what it built: the deploy job's choice of sites is the matrix's, both from the plan job", () => {
    const text = job("deploy");
    expect(text).toMatch(/^ {6}DEPLOY_MAINNET: \$\{\{ needs\.plan\.outputs\.mainnet \}\}$/m);
    expect(text).toMatch(/^ {6}DEPLOY_TESTNET: \$\{\{ needs\.plan\.outputs\.testnet \}\}$/m);
    expect(text).not.toMatch(/inputs\.targets/);
    expect(job("bundle")).not.toMatch(/inputs\.targets/);
  });

  it("builds the testnet bundle with apphosting.testnet.yaml merged in, and checks each bundle's network", () => {
    const list = steps("bundle");
    const settings = list.findIndex((s) => /apphosting-env\.mjs/.test(s));
    const guard = list.findIndex((s) => /test "\$NEXT_PUBLIC_ARC_NETWORK" = "\$SITE"/.test(s));
    const build = list.findIndex((s) => /run: npm run build -w @arcos\/web$/m.test(s));
    expect(list[settings]).toMatch(/^ {10}APPHOSTING_ENVIRONMENT: \$\{\{ matrix\.site == 'testnet' && 'testnet' \|\| '' \}\}$/m);
    expect(list[settings]).toMatch(/^ {8}run: node scripts\/apphosting-env\.mjs --environment "\$APPHOSTING_ENVIRONMENT" \| tee -a "\$GITHUB_ENV"$/m);
    expect(list[guard]).toMatch(/^ {10}SITE: \$\{\{ matrix\.site \}\}$/m);
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(settings);
    expect(build).toBeGreaterThan(guard);
  });

  it("deploys 4rc.OS first, and the testnet site only after 4rc.OS's deploy has succeeded or wasn't asked for", () => {
    const mainnet = deployStep("deploy-mainnet");
    const testnet = deployStep("deploy-testnet");
    expect(mainnet).toMatch(/^ {8}if: \$\{\{ !inputs\.dry_run && env\.DEPLOY_MAINNET == 'true' \}\}$/m);
    expect(testnet).toMatch(/^ {8}if: \$\{\{ !inputs\.dry_run && env\.DEPLOY_TESTNET == 'true' \}\}$/m);
    const list = steps("deploy");
    const guard = list.find((s) => /environment name must be testnet/.test(s));
    expect(list.indexOf(guard)).toBe(list.indexOf(mainnet) + 1);
    expect(list.indexOf(testnet)).toBe(list.indexOf(guard) + 1);
    // Nothing lets a step run after a failure, or a failure pass: the testnet step runs only while every step before it
    // has succeeded, and a failed deploy fails the job.
    for (const step of list) {
      expect(step).not.toMatch(/always\(\)|failure\(\)|continue-on-error/);
    }
    expect(job("deploy")).not.toMatch(/continue-on-error/);
  });

  // Without the environment name, App Hosting builds arcos-testnet from apphosting.yaml alone: 4rc.OS under another name.
  it("reads the testnet backend's environment name before deploying it, and stops unless it is testnet", () => {
    const guard = steps("deploy").find((s) => /environment name must be testnet/.test(s));
    expect(guard).toMatch(/^ {8}if: \$\{\{ !inputs\.dry_run && env\.DEPLOY_TESTNET == 'true' \}\}$/m);
    const [read, check] = runScripts(guard)[0].split("\n");
    expect(read).toBe(
      `name="$(tools/firebase/node_modules/.bin/firebase apphosting:backends:get "$APPHOSTING_TESTNET_BACKEND" --project "$FIREBASE_PROJECT" --non-interactive --json | jq -r '.result.environment // ""')"`,
    );
    expect(check).toMatch(/^if \[ "\$name" != testnet \]; then echo "::error::.*"; exit 1; fi$/);
  });

  it("stays under the hour of the CLI's access token in each deploy step", () => {
    for (const id of ["deploy-mainnet", "deploy-testnet"]) expect(deployStep(id)).toMatch(/^ {8}timeout-minutes: 40$/m);
  });

  it("deploys each backend by name, never every backend in firebase.json at once", () => {
    const deploys = runScripts(job("deploy")).filter((r) => /firebase deploy/.test(r) && /apphosting/.test(r));
    expect(deploys).toHaveLength(2);
    for (const r of deploys) expect(r).toMatch(/--only "apphosting:\$\{APPHOSTING(_TESTNET)?_BACKEND\}"/);
    expect(deployCode).not.toMatch(/--only "?apphosting"?(\s|$)/);
  });

  it("tells the smoke job whether 4rc.OS's deploy succeeded, so a testnet failure after it doesn't skip its checks", () => {
    expect(job("deploy")).toMatch(/^ {4}outputs:\n {6}mainnet: \$\{\{ steps\.deploy-mainnet\.outcome \}\}$/m);
  });
});

// The testnet leg runs only once the owner has set the repository variable ARCOS_TESTNET_READY to `true`, after the
// arcos-testnet backend exists with its environment name. Until then a push deploys 4rc.OS alone (the testnet bundle
// isn't even built), and a manual run that asks for the testnet site fails before anything builds.
describe("deploy.yml, the testnet gate", () => {
  /** Runs the plan job's script as Actions runs it (bash -eo pipefail), and returns what it wrote and printed. */
  function plan({ targets = "", ready, functionsReady } = {}) {
    const [script, ...rest] = runScripts(job("plan"));
    expect(rest).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-plan-"));
    const output = path.join(dir, "output");
    fs.writeFileSync(output, "");
    const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, TARGETS: targets };
    if (ready !== undefined) env.TESTNET_READY = ready;
    if (functionsReady !== undefined) env.FUNCTIONS_READY = functionsReady;
    const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { env, encoding: "utf8" });
    const written = Object.fromEntries(
      fs
        .readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: run.status, stdout: run.stdout, written };
  }
  const chose = (sites, { functions = false } = {}) => ({
    sites: JSON.stringify(sites),
    mainnet: String(sites.includes("mainnet")),
    testnet: String(sites.includes("testnet")),
    functions: String(functions),
  });

  it("reads the variable in one place only: the plan job's env, never the bundle or deploy job", () => {
    expect(deployCode.match(/\bvars\.ARCOS_TESTNET_READY\b/g)).toHaveLength(1);
    expect(job("bundle")).not.toMatch(/ARCOS_TESTNET_READY/);
    expect(job("deploy")).not.toMatch(/ARCOS_TESTNET_READY/);
    expect(job("plan")).toMatch(/^ {10}TESTNET_READY: \$\{\{ vars\.ARCOS_TESTNET_READY \}\}$/m);
    expect(job("plan")).toMatch(/^ {10}TARGETS: \$\{\{ inputs\.targets \}\}$/m);
  });

  it("chooses the sites in a job that holds nothing and runs nothing of the project's", () => {
    const text = job("plan");
    expect(text).toMatch(/^ {4}permissions: \{\}$/m);
    expect(text).not.toMatch(/uses:|secrets\.|id-token|environment:|GITHUB_TOKEN/);
    expect(text).toMatch(
      /^ {4}outputs:\n {6}sites: \$\{\{ steps\.plan\.outputs\.sites \}\}\n {6}mainnet: \$\{\{ steps\.plan\.outputs\.mainnet \}\}\n {6}testnet: \$\{\{ steps\.plan\.outputs\.testnet \}\}$/m,
    );
    expect(job("deploy")).toMatch(/^ {4}needs: \[plan, checks, bundle, functions-bundle\]$/m);
  });

  it("interpolates no expression into any script: values reach a run only through env", () => {
    for (const workflow of [deploy, ci]) {
      for (const script of runScripts(workflow)) expect(script).not.toMatch(/\$\{\{/);
    }
  });

  it("on a push, deploys 4rc.OS alone until the variable is exactly true, and says so", () => {
    for (const ready of [undefined, "", "false", "TRUE", "True", "1", "yes", " true"]) {
      const result = plan({ ready });
      expect(result.status, String(ready)).toBe(0);
      expect(result.written, String(ready)).toEqual(chose(["mainnet"]));
      expect(result.stdout).toMatch(/^::notice::.*ARCOS_TESTNET_READY/m);
    }
  });

  it("on a push, deploys both once the variable is true", () => {
    const result = plan({ ready: "true", functionsReady: "true" });
    expect(result.status).toBe(0);
    expect(result.written).toEqual(chose(["mainnet", "testnet"], { functions: true }));
    expect(result.stdout).not.toMatch(/::notice::|::error::/);
  });

  it("fails a manual run that asks for the testnet site before the variable is true, with nothing chosen", () => {
    for (const targets of ["both", "testnet"]) {
      for (const ready of [undefined, "false"]) {
        const result = plan({ targets, ready });
        expect(result.status, `${targets} ${ready}`).not.toBe(0);
        expect(result.written).toEqual({});
        expect(result.stdout).toMatch(/^::error::.*ARCOS_TESTNET_READY.*targets: mainnet/m);
      }
    }
  });

  it("does what a manual run asks once the variable is true, and mainnet alone whatever it is", () => {
    expect(plan({ targets: "both", ready: "true" }).written).toEqual(chose(["mainnet", "testnet"]));
    expect(plan({ targets: "testnet", ready: "true" }).written).toEqual(chose(["testnet"]));
    for (const ready of [undefined, "true"]) {
      const result = plan({ targets: "mainnet", ready });
      expect(result.status).toBe(0);
      expect(result.written).toEqual(chose(["mainnet"]));
      expect(result.stdout).not.toMatch(/::notice::|::error::/);
    }
  });

  it("deploys no functions from a manual run of the sites, whatever the variables say", () => {
    for (const targets of ["both", "mainnet", "testnet"]) {
      const result = plan({ targets, ready: "true", functionsReady: "true" });
      expect(result.written, targets).toMatchObject({ functions: "false" });
    }
  });

  it("refuses a target it doesn't know", () => {
    const result = plan({ targets: "devnet", ready: "true" });
    expect(result.status).not.toBe(0);
    expect(result.written).toEqual({});
  });
});

// The functions join a run only once the owner has set ARCOS_FUNCTIONS_READY to `true`, after the arcos database, the
// account arcos-jobs@ and the deployer's roles exist (docs/OPERATIONS.md). Until then a push deploys the sites alone,
// and a manual run that asks for them fails before anything builds. The Firestore indexes and rules are never deployed
// from the workflow: the pinned CLI compiles the rules even for an indexes-only deploy, and the deployer has no rules
// role, on purpose. The owner deploys both by hand.
describe("deploy.yml, the functions", () => {
  function plan({ targets = "", testnetReady = "true", functionsReady } = {}) {
    const [script] = runScripts(job("plan"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-plan-"));
    const output = path.join(dir, "output");
    fs.writeFileSync(output, "");
    const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, TARGETS: targets, TESTNET_READY: testnetReady };
    if (functionsReady !== undefined) env.FUNCTIONS_READY = functionsReady;
    const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { env, encoding: "utf8" });
    const written = Object.fromEntries(
      fs.readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: run.status, stdout: run.stdout, written };
  }
  const step = (id) => steps("deploy").find((s) => new RegExp(`^ {8}id: ${id}$`, "m").test(s));

  it("reads the variable in the plan job's env only", () => {
    expect(deployCode.match(/\bvars\.ARCOS_FUNCTIONS_READY\b/g)).toHaveLength(1);
    expect(job("plan")).toMatch(/^ {10}FUNCTIONS_READY: \$\{\{ vars\.ARCOS_FUNCTIONS_READY \}\}$/m);
    expect(job("plan")).toMatch(/^ {6}functions: \$\{\{ steps\.plan\.outputs\.functions \}\}\n {4}steps:$/m);
  });

  it("on a push, adds the functions only when the variable is exactly true, and says so otherwise", () => {
    for (const functionsReady of [undefined, "", "false", "TRUE", "1"]) {
      const result = plan({ functionsReady });
      expect(result.status).toBe(0);
      expect(result.written).toEqual({ sites: '["mainnet","testnet"]', mainnet: "true", testnet: "true", functions: "false" });
      expect(result.stdout).toMatch(/^::notice::.*ARCOS_FUNCTIONS_READY/m);
    }
    expect(plan({ functionsReady: "true" }).written).toEqual({ sites: '["mainnet","testnet"]', mainnet: "true", testnet: "true", functions: "true" });
  });

  it("deploys the functions alone from a manual run, building no site, and fails that run before the variable is true", () => {
    expect(plan({ targets: "functions", functionsReady: "true" }).written).toEqual({ sites: "[]", mainnet: "false", testnet: "false", functions: "true" });
    const result = plan({ targets: "functions", functionsReady: "false" });
    expect(result.status).not.toBe(0);
    expect(result.written).toEqual({});
    expect(result.stdout).toMatch(/^::error::.*ARCOS_FUNCTIONS_READY/m);
  });

  it("has no indexes target any more: a manual run that asks for it fails like any unknown target", () => {
    const result = plan({ targets: "indexes", functionsReady: "true" });
    expect(result.status).not.toBe(0);
    expect(result.written).toEqual({});
  });

  it("skips the site bundles when no site is chosen, since a matrix can't be empty", () => {
    expect(job("bundle")).toMatch(/^ {4}if: needs\.plan\.outputs\.sites != '\[\]'$/m);
  });

  it("builds the functions in a job with no credential of any kind, and hands over the two built files only", () => {
    const text = job("functions-bundle");
    expect(text).toMatch(/^ {4}needs: plan$/m);
    expect(text).toMatch(/^ {4}if: needs\.plan\.outputs\.functions == 'true'$/m);
    expect(text).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}steps:/m);
    expect(text).not.toMatch(/secrets\.|vars\.|GITHUB_TOKEN|google-github-actions|GOOGLE_|id-token|tools\/firebase/);
    expect(text).toMatch(/persist-credentials: false/);
    expect(text).toMatch(/run: npm ci$/m);
    expect(text).toMatch(/run: npm run build -w @arcos\/functions$/m);
    const up = steps("functions-bundle").find((s) => /actions\/upload-artifact@/.test(s));
    expect(up.match(/^ {10}name: (.+)$/m)?.[1]).toBe("bundle-functions");
    expect(up).toMatch(/path: \|\n {12}functions\/deploy\/index\.js\n {12}functions\/deploy\/functions\.yaml\n/);
    expect(up).toMatch(/if-no-files-found: error/);
    expect(up).toMatch(/retention-days: 1$/m);
  });

  it("scans the functions bundle with the sites', then copies it into functions/deploy without running anything", () => {
    const list = steps("deploy");
    const scan = list.findIndex((s) => /scripts\/scan-bundle\.mjs/.test(s));
    const place = list.findIndex((s) => /Put the functions bundle in place/.test(s));
    expect(place).toBeGreaterThan(scan);
    expect(list[place]).toMatch(/^ {8}if: env\.DEPLOY_FUNCTIONS == 'true'$/m);
    expect(runScripts(list[place])).toEqual(['cp "$RUNNER_TEMP/bundle-functions/index.js" "$RUNNER_TEMP/bundle-functions/functions.yaml" functions/deploy/']);
  });

  it("deploys the functions after the sites, by codebase and only when chosen, and never Firestore", () => {
    const list = steps("deploy");
    const functions = step("deploy-functions");
    expect(functions).toMatch(/^ {8}if: \$\{\{ !inputs\.dry_run && env\.DEPLOY_FUNCTIONS == 'true' \}\}$/m);
    expect(runScripts(functions)).toEqual(['tools/firebase/node_modules/.bin/firebase deploy --only functions:arcos --project "$FIREBASE_PROJECT" --non-interactive']);
    expect(list.indexOf(functions)).toBe(list.indexOf(step("deploy-testnet")) + 1);
    expect(functions).toMatch(/^ {8}timeout-minutes: \d+$/m);
    // Never Firestore: the CLI compiles the rules even for `--only firestore:indexes`, and the deployer has no rules
    // role. Never every codebase, never everything.
    expect(step("deploy-indexes")).toBeUndefined();
    expect(deployCode).not.toMatch(/firestore|DEPLOY_INDEXES|outputs\.indexes/);
    expect(deployCode).not.toMatch(/--only "?functions"?(\s|$)/);
    expect(deployCode.match(/ deploy --only /g)).toHaveLength(3);
    expect(job("deploy")).toMatch(/^ {6}DEPLOY_FUNCTIONS: \$\{\{ needs\.plan\.outputs\.functions \}\}\n {4}# /m);
  });

  it("matches firebase.json: the codebase it deploys is the one entry there, from the folder the bundle lands in", () => {
    expect(JSON.parse(read("firebase.json")).functions).toEqual([
      { codebase: "arcos", source: "functions/deploy", runtime: "nodejs22", ignore: ["node_modules"] },
    ]);
    for (const entry of JSON.parse(read("firebase.json")).apphosting) {
      expect(entry.ignore).toEqual(expect.arrayContaining(["functions/deploy/index.js", "functions/deploy/functions.yaml"]));
    }
  });
});

// The manifest the functions build wrote decides what the CLI deploys, and that build ran the project's code. So the
// deploy job checks it with jq before it signs in, and refuses anything but the one scheduled function it expects.
describe("deploy.yml, the check of the functions manifest", () => {
  const JOBS = "arcos-jobs@arcos-c80cf.iam.gserviceaccount.com";
  /** The manifest the build writes today (functions/src/__tests__/bundle.test.ts runs the real one through this check). */
  const good = () => ({
    specVersion: "v1alpha1",
    endpoints: {
      arcosIndexer: {
        availableMemoryMb: 512,
        timeoutSeconds: 120,
        minInstances: null,
        maxInstances: 1,
        ingressSettings: null,
        concurrency: 1,
        serviceAccountEmail: JOBS,
        vpc: null,
        platform: "gcfv2",
        region: ["europe-west4"],
        secretEnvironmentVariables: [{ key: "BLOCKSCOUT_API_KEY" }],
        labels: {},
        scheduleTrigger: { schedule: "every 1 minutes", retryConfig: { retryCount: 0 }, timeZone: "Etc/UTC" },
        entryPoint: "arcosIndexer",
      },
    },
    params: [{ type: "secret", name: "BLOCKSCOUT_API_KEY" }],
    requiredAPIs: [{ api: "cloudscheduler.googleapis.com", reason: "Needed for scheduled functions." }],
    extensions: {},
  });
  const step = () => steps("deploy").find((s) => /- name: Check the functions manifest$/m.test(s));
  /** The step's literal env values. */
  const stepEnv = () => Object.fromEntries([...step().matchAll(/^ {10}([A-Z_]+): (\S+)$/gm)].map((m) => [m[1], m[2]]));

  /** Runs the step's script as Actions would, on `text` as the downloaded functions.yaml (none when null). */
  function check(text) {
    const [script, ...rest] = runScripts(step());
    expect(rest).toEqual([]);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-manifest-"));
    fs.mkdirSync(path.join(temp, "bundle-functions"));
    if (text !== null) fs.writeFileSync(path.join(temp, "bundle-functions", "functions.yaml"), text);
    const env = { PATH: process.env.PATH, RUNNER_TEMP: temp, ...stepEnv() };
    const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { env, encoding: "utf8" });
    fs.rmSync(temp, { recursive: true, force: true });
    return { status: run.status, stdout: run.stdout };
  }
  const json = (manifest) => JSON.stringify(manifest, null, 2);
  /** The good manifest with `change` applied to it. */
  const changed = (change) => {
    const manifest = good();
    change(manifest, manifest.endpoints.arcosIndexer);
    return json(manifest);
  };
  const refused = (text, message) => {
    const result = check(text);
    expect(result.status, message.source).not.toBe(0);
    expect(result.stdout).toMatch(/^::error::functions\.yaml .*, so nothing is deployed/m);
    expect(result.stdout).toMatch(message);
  };

  it("runs after the scan and before the bundle is put in place and the sign-in, only when the functions deploy", () => {
    const list = steps("deploy");
    const at = (pattern) => list.findIndex((s) => pattern.test(s));
    const index = at(/- name: Check the functions manifest$/m);
    expect(index).toBeGreaterThan(at(/scripts\/scan-bundle\.mjs/));
    expect(index).toBeLessThan(at(/Put the functions bundle in place/));
    expect(index).toBeLessThan(at(/uses: google-github-actions\/auth@/));
    expect(step()).toMatch(/^ {8}if: env\.DEPLOY_FUNCTIONS == 'true'$/m);
    expect(stepEnv()).toMatchObject({ FUNCTIONS_ENDPOINT: "arcosIndexer", JOBS_ACCOUNT: JOBS, FUNCTIONS_REGION: "europe-west4", FUNCTIONS_SECRET: "BLOCKSCOUT_API_KEY" });
    expect(Object.keys(stepEnv()).sort()).toEqual(["FUNCTIONS_APIS", "FUNCTIONS_ENDPOINT", "FUNCTIONS_REGION", "FUNCTIONS_SECRET", "JOBS_ACCOUNT"]);
  });

  // The CLI enables a required API on the standard list without asking (deploy/functions/prepare.js,
  // ensureAllRequiredAPIsEnabled); the check allows that list and nothing else, so it must be the pinned CLI's.
  const prepare = path.join(root, "tools/firebase/node_modules/firebase-tools/lib/deploy/functions/prepare.js");
  it.runIf(fs.existsSync(prepare))("allows exactly the pinned CLI's STANDARD_APIS as required APIs", () => {
    const list = fs.readFileSync(prepare, "utf8").match(/const STANDARD_APIS = \[([^\]]*)\]/);
    expect(list, "prepare.js declares STANDARD_APIS").not.toBeNull();
    const standard = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(standard.length).toBeGreaterThan(5);
    expect(stepEnv().FUNCTIONS_APIS.split(",")).toEqual(standard);
  });

  it("uses jq and the shell only: no node, no npm, no project script", () => {
    const [script] = runScripts(step());
    expect(script).not.toMatch(/\b(node|npm|npx)\b|scripts\//);
    expect(script).toMatch(/\bjq -e\b/);
    // Each rule is its own jq check with its own message, and a failed check stops the step.
    expect(script.match(/\|\| fail "/g).length).toBe(15);
    expect(script).not.toMatch(/\$\{\{/);
  });

  it("passes the manifest the build writes, and says what it deploys", () => {
    const result = check(json(good()));
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toMatch(/^functions\.yaml: arcosIndexer, scheduled, as arcos-jobs@arcos-c80cf\.iam\.gserviceaccount\.com, in europe-west4\.$/m);
    // Optional keys may be absent.
    expect(check(changed((m, e) => (delete m.extensions, delete m.params, delete e.secretEnvironmentVariables))).status).toBe(0);
    expect(check(changed((m) => (m.extensions = []))).status).toBe(0);
  });

  it("refuses a file that is missing, empty, not JSON, or more than one document", () => {
    refused(null, /is not one JSON object/);
    refused("", /is not one JSON object/);
    refused("specVersion: v1alpha1\nendpoints: {}\n", /is not one JSON object/);
    refused(`${json(good())}\n${json(good())}`, /is not one JSON object/);
    refused("[]", /is not one JSON object/);
    refused(json({ specVersion: "v1alpha1" }), /endpoints other than arcosIndexer alone/);
    refused(json({ ...good(), endpoints: {} }), /endpoints other than arcosIndexer alone/);
  });

  it("refuses any endpoint set but arcosIndexer alone, even one named arcos*", () => {
    refused(changed((m, e) => (m.endpoints = { indexer: e })), /endpoints other than arcosIndexer alone/);
    refused(changed((m, e) => (m.endpoints.otherIndexer = e)), /endpoints other than arcosIndexer alone/);
    refused(changed((m, e) => (m.endpoints.arcosOther = e)), /endpoints other than arcosIndexer alone/);
    refused(changed((m, e) => (m.endpoints = { arcosindexer: e })), /endpoints other than arcosIndexer alone/);
  });

  it("refuses an endpoint that isn't gcfv2", () => {
    refused(changed((m, e) => (e.platform = "gcfv1")), /not gcfv2/);
    refused(changed((m, e) => (e.platform = "run")), /not gcfv2/);
    refused(changed((m, e) => delete e.platform), /not gcfv2/);
  });

  it("refuses a VPC, environment variables or an ingress setting", () => {
    refused(changed((m, e) => (e.vpc = { connector: "projects/arcos-c80cf/locations/europe-west4/connectors/c", egressSettings: "ALL_TRAFFIC" })), /puts an endpoint on a VPC/);
    refused(changed((m, e) => (e.environmentVariables = { INSPECT_PER_TICK: "50" })), /environment variables/);
    refused(changed((m, e) => (e.ingressSettings = "ALLOW_INTERNAL_ONLY")), /sets an endpoint's ingress/);
    refused(changed((m, e) => (e.ingressSettings = "ALLOW_ALL")), /sets an endpoint's ingress/);
    // As the build writes them today: vpc and ingressSettings null, no environment variables.
    expect(check(changed((m, e) => (delete e.vpc, delete e.ingressSettings, (e.environmentVariables = {})))).status).toBe(0);
  });

  it("refuses required roles, even none", () => {
    refused(changed((m) => (m.requiredRoles = ["roles/owner"])), /declares required roles/);
    refused(changed((m) => (m.requiredRoles = [])), /declares required roles/);
  });

  it("refuses a required API outside the CLI's standard list", () => {
    refused(changed((m) => m.requiredAPIs.push({ api: "iam.googleapis.com", reason: "x" })), /an API outside the CLI's standard list/);
    refused(changed((m) => (m.requiredAPIs = [{ api: "cloudscheduler.googleapis.com.evil", reason: "x" }])), /an API outside the CLI's standard list/);
    refused(changed((m) => (m.requiredAPIs = [{ reason: "no api" }])), /an API outside the CLI's standard list/);
    expect(check(changed((m) => (m.requiredAPIs = [{ api: "cloudtasks.googleapis.com", reason: "x" }, { api: "run.googleapis.com", reason: "y" }]))).status).toBe(0);
    expect(check(changed((m) => delete m.requiredAPIs)).status).toBe(0);
  });

  it("refuses an endpoint that runs as another account, under either key the CLI reads", () => {
    refused(changed((m, e) => (e.serviceAccountEmail = "other@arcos-c80cf.iam.gserviceaccount.com")), /an account other than arcos-jobs@/);
    refused(changed((m, e) => delete e.serviceAccountEmail), /an account other than arcos-jobs@/);
    refused(changed((m, e) => (e.serviceAccount = "other@arcos-c80cf.iam.gserviceaccount.com")), /an account other than arcos-jobs@/);
    expect(check(changed((m, e) => (e.serviceAccount = JOBS))).status).toBe(0);
  });

  it("refuses any trigger but a schedule, beside it or in its place", () => {
    for (const trigger of ["httpsTrigger", "callableTrigger", "eventTrigger", "taskQueueTrigger", "blockingTrigger", "dataConnectGraphqlTrigger"]) {
      refused(changed((m, e) => (e[trigger] = {})), /triggered by something other than a schedule alone/);
      refused(changed((m, e) => ((e[trigger] = {}), delete e.scheduleTrigger)), /triggered by something other than a schedule alone/);
    }
    refused(changed((m, e) => delete e.scheduleTrigger), /triggered by something other than a schedule alone/);
    refused(changed((m, e) => (e.scheduleTrigger = "every 1 minutes")), /triggered by something other than a schedule alone/);
  });

  it("refuses a region other than europe-west4, or more than one", () => {
    refused(changed((m, e) => (e.region = ["us-central1"])), /outside europe-west4/);
    refused(changed((m, e) => (e.region = ["europe-west4", "us-central1"])), /outside europe-west4/);
    refused(changed((m, e) => delete e.region), /outside europe-west4/);
  });

  it("refuses extensions and lifecycle hooks", () => {
    refused(changed((m) => (m.extensions = { "an-extension": { ref: "x/y@1.0.0", params: {} } })), /declares extensions/);
    refused(changed((m) => (m.lifecycleHooks = {})), /declares lifecycle hooks/);
  });

  it("refuses a param or a secret other than the secret BLOCKSCOUT_API_KEY", () => {
    refused(changed((m) => m.params.push({ type: "string", name: "BLOCKSCOUT_API_KEY" })), /a param other than the secret BLOCKSCOUT_API_KEY/);
    refused(changed((m) => (m.params = [{ type: "secret", name: "OTHER_KEY" }])), /a param other than the secret BLOCKSCOUT_API_KEY/);
    refused(changed((m) => (m.params = [{ type: "int", name: "INSPECT_PER_TICK" }])), /a param other than the secret BLOCKSCOUT_API_KEY/);
    refused(changed((m, e) => e.secretEnvironmentVariables.push({ key: "OTHER_KEY" })), /a secret other than BLOCKSCOUT_API_KEY/);
    refused(changed((m, e) => (e.secretEnvironmentVariables = [{ key: "BLOCKSCOUT_API_KEY", secret: "OTHER_KEY" }])), /a secret other than BLOCKSCOUT_API_KEY/);
  });
});

describe("the Firebase CLI the deploy runs", () => {
  const tools = "tools/firebase";
  const cli = `${tools}/node_modules/.bin/firebase`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // as a pattern
  const pkg = () => JSON.parse(read(`${tools}/package.json`));
  const lock = () => JSON.parse(read(`${tools}/package-lock.json`));

  it("is a private package that names the CLI at one exact version, and nothing else", () => {
    expect(pkg().private).toBe(true);
    expect(Object.keys(pkg().dependencies)).toEqual(["firebase-tools"]);
    expect(pkg().dependencies["firebase-tools"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg().devDependencies).toBeUndefined();
  });

  it("is locked: that version and every package under it, each with an integrity hash from the npm registry", () => {
    const { lockfileVersion, packages } = lock();
    expect(lockfileVersion).toBe(3);
    expect(packages["node_modules/firebase-tools"].version).toBe(pkg().dependencies["firebase-tools"]);
    const entries = Object.entries(packages).filter(([name]) => name !== "");
    expect(entries.length).toBeGreaterThan(100);
    for (const [name, entry] of entries) {
      expect(entry.resolved, `${name} has a registry URL`).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, `${name} has a hash`).toMatch(/^sha512-/);
      expect(entry.extraneous, `${name} is needed by something`).toBeUndefined(); // npm leaves these after a first pass
    }
  });

  it("is installed from the lockfile without install scripts, and the deploy runs that binary, never npx", () => {
    const text = job("deploy");
    expect(text).toMatch(/^ {8}run: npm ci --ignore-scripts --prefix tools\/firebase$/m);
    expect(deployCode).not.toMatch(/\bnpx\b/); // npx would resolve the CLI's whole tree afresh on every run
    expect(deployCode).not.toMatch(/FIREBASE_TOOLS_VERSION|firebase-tools@/);
    expect(text).toMatch(new RegExp(`^ {8}run: ${cli} deploy --only "apphosting:\\$\\{APPHOSTING_BACKEND\\}" --project "\\$FIREBASE_PROJECT" --non-interactive$`, "m"));
    expect(text).toMatch(new RegExp(`^ {8}run: ${cli} deploy --only "apphosting:\\$\\{APPHOSTING_TESTNET_BACKEND\\}" --project "\\$FIREBASE_PROJECT" --non-interactive$`, "m"));
    expect(text).toMatch(new RegExp(`^ {8}run: ${cli} apphosting:backends:list --project "\\$FIREBASE_PROJECT" --non-interactive$`, "m"));
  });

  it("stays out of the source the CLI uploads, and is not an npm workspace of the root", () => {
    const firebase = JSON.parse(read("firebase.json"));
    expect(firebase.apphosting[0].ignore).toContain("node_modules"); // matched at any depth, so this folder's too
    expect(read(".gitignore")).toMatch(/^node_modules$/m);
    const { workspaces } = JSON.parse(read("package.json"));
    for (const glob of workspaces) expect(glob, "a workspace glob").toMatch(/^((apps|packages)\/[^/]*|functions)$/);
    const rootLock = JSON.parse(read("package-lock.json"));
    expect(Object.keys(rootLock.packages).filter((name) => name === "tools" || name.startsWith("tools/"))).toEqual([]);
  });
});

describe("firebase.json's App Hosting backends", () => {
  const entries = () => JSON.parse(read("firebase.json")).apphosting;

  it("lists the mainnet backend first and the testnet backend second, and no other", () => {
    expect(entries().map((e) => e.backendId)).toEqual(["arcos", "arcos-testnet"]);
  });

  // The same source: the testnet backend differs only by its environment name, which picks apphosting.testnet.yaml.
  it("gives both the same root and the same ignore list", () => {
    const [mainnet, testnet] = entries();
    expect(mainnet.rootDir).toBe("apps/web");
    expect(testnet).toEqual({ ...mainnet, backendId: "arcos-testnet" });
    for (const entry of entries()) expect(entry.ignore).toContain(".env.local");
  });

  it("keeps a settings file for the testnet environment beside the base one", () => {
    expect(fs.existsSync(path.join(root, "apps/web/apphosting.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "apps/web/apphosting.testnet.yaml"))).toBe(true);
  });
});

describe("the Firestore tests in CI", () => {
  const emulator = read(".github/workflows/emulator.yml");
  const install = /^ {6}- run: npm ci --ignore-scripts --prefix tools\/firebase$/m;
  const at = (text, pattern) => text.search(pattern);

  it("runs the @arcos/data unit tests with the other workspaces, after installing the pinned Firebase CLI", () => {
    const unit = /^ {8}run: npm run test (--workspace=@arcos\/\S+ )*--workspace=@arcos\/data( --workspace=@arcos\/\S+)*$/m;
    expect(ci).toMatch(unit);
    expect(ci).toMatch(install);
    expect(at(ci, install)).toBeLessThan(at(ci, unit));
  });

  it("runs the emulator suite with the same CLI, installed without install scripts", () => {
    const suite = /^ {8}run: npm run test:emulator -w @arcos\/data$/m;
    expect(emulator).toMatch(suite);
    expect(emulator).toMatch(install);
    expect(at(emulator, install)).toBeLessThan(at(emulator, suite));
    expect(emulator).not.toMatch(/firebase-tools@|\bnpx\b/);
  });

  it("audits the Firebase CLI's packages too, since CI now installs and loads them", () => {
    expect(ci).toMatch(/^ {8}run: node scripts\/audit\.mjs --prefix tools\/firebase$/m);
  });

  it("runs the functions' unit tests with the other workspaces, and their emulator suite with the same CLI", () => {
    expect(ci).toMatch(/^ {8}run: npm run test (--workspace=@arcos\/\S+ )*--workspace=@arcos\/functions( --workspace=@arcos\/\S+)*$/m);
    const suite = /^ {8}run: npm run test:emulator -w @arcos\/functions$/m;
    expect(emulator).toMatch(suite);
    expect(at(emulator, install)).toBeLessThan(at(emulator, suite));
  });

  it("audits the functions' own lockfile, which Cloud Build installs from", () => {
    expect(ci).toMatch(/^ {8}run: node scripts\/audit\.mjs --prefix functions\/deploy$/m);
  });

  it("runs all three audits through scripts/audit.mjs, whose allowlist is explicit, scoped per audit root, and expires", () => {
    expect(ci).not.toMatch(/^ {8}run: npm audit\b/m);
    expect(fs.existsSync(path.join(root, "scripts/audit-allowlist.json"))).toBe(true);
    const audits = ci.split("\n").filter((line) => /^ {8}run: .*\baudit\b/.test(line));
    expect(audits).toEqual([
      "        run: node scripts/audit.mjs",
      "        run: node scripts/audit.mjs --prefix tools/firebase",
      "        run: node scripts/audit.mjs --prefix functions/deploy",
    ]);
  });

  it("allows nothing in functions/deploy, and nothing as a runtime dependency except in tools/firebase", () => {
    const allowlist = JSON.parse(read("scripts/audit-allowlist.json"));
    for (const entry of allowlist) {
      expect(entry.paths ?? ["."]).not.toContain("functions/deploy");
      if (entry.runtime) expect(entry.paths).toEqual(["tools/firebase"]);
    }
  });

  it("leaves no GitHub token in the checkout of either job, since both run the CLI's code", () => {
    for (const text of [ci, emulator]) {
      expect(text).toMatch(/- uses: actions\/checkout@v7\n {8}with:\n {10}persist-credentials: false\n/);
    }
  });
});

describe("the end-to-end smoke job in ci.yml", () => {
  const e2e = () => job("e2e", ci);
  const pkg = () => JSON.parse(read("package.json"));

  it("runs beside the checks with read access only, no credential and no secret", () => {
    const text = e2e();
    expect(text).not.toMatch(/^ {4}needs:/m);
    expect(text).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}[a-z]/m); // that permission alone
    expect(text).not.toMatch(/secrets\.|vars\.|GITHUB_TOKEN|id-token|google-github-actions|BLOCKSCOUT_API_KEY/);
    expect(text).toMatch(/- uses: actions\/checkout@v7\n {8}with:\n {10}persist-credentials: false\n/);
  });

  it("leaves no GitHub token in any checkout of ci.yml", () => {
    const checkouts = ci.match(/uses: actions\/checkout@/g) ?? [];
    expect(checkouts.length).toBeGreaterThan(1);
    expect(ci.match(/uses: actions\/checkout@v7\n {8}with:\n {10}persist-credentials: false\n/g)).toHaveLength(checkouts.length);
  });

  it("installs from the lockfile with the ci job's Node and npm, then a browser, then builds and runs the suite", () => {
    const text = e2e();
    const at = (needle) => text.indexOf(needle);
    expect(text).toMatch(/node-version-file: \.nvmrc$/m);
    expect(at("run: npm install -g npm@11.19.1")).toBeGreaterThanOrEqual(0);
    expect(ci.match(/run: npm install -g npm@\S+/g)).toEqual(["run: npm install -g npm@11.19.1", "run: npm install -g npm@11.19.1"]);
    expect(at("run: npm ci\n")).toBeGreaterThan(at("run: npm install -g npm@11.19.1"));
    expect(at("run: npx playwright install --with-deps chromium\n")).toBeGreaterThan(at("run: npm ci\n"));
    expect(at("run: npm run build -w @arcos/web\n")).toBeGreaterThan(at("run: npx playwright install --with-deps chromium\n"));
    expect(at("run: npm run test:e2e\n")).toBeGreaterThan(at("run: npm run build -w @arcos/web\n"));
  });

  it("pins Playwright to one exact version, and downloads browsers in CI only, never from an npm script", () => {
    expect(pkg().devDependencies["@playwright/test"]).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [name, script] of Object.entries(pkg().scripts)) {
      expect(script, `script ${name}`).not.toMatch(/playwright install/);
    }
    expect(deploy).not.toMatch(/playwright/); // the deploy's own jobs never download a browser
  });

  it("typechecks the suite and its config, which the workspaces' typecheck doesn't reach", () => {
    const text = e2e();
    expect(pkg().scripts["typecheck:e2e"]).toBe("tsc -p e2e/tsconfig.json");
    expect(text.indexOf("run: npm run typecheck:e2e\n")).toBeGreaterThan(text.indexOf("run: npm ci\n"));
  });

  it("builds with the settings App Hosting reads, like the deploy's bundle, and never with the local Chromium path", () => {
    const text = e2e();
    const settings = text.indexOf('run: node scripts/apphosting-env.mjs | tee -a "$GITHUB_ENV"\n');
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("run: npm run build -w @arcos/web\n")).toBeGreaterThan(settings);
    expect(text).not.toMatch(/^\s*NEXT_PUBLIC_[A-Z_]+:/m); // no value set by hand beside the file's
    expect(ci).not.toMatch(/^\s*E2E_CHROMIUM_PATH:/m);
  });

  it("uploads the report only when the suite fails", () => {
    const text = e2e();
    const upload = text.slice(text.indexOf("- name: Upload the Playwright report"));
    expect(upload).toMatch(/if: failure\(\)/);
    expect(upload).toMatch(/uses: actions\/upload-artifact@v\d+$/m);
    expect(upload).toMatch(/path: playwright-report\/$/m);
  });
});

// The owner sets the functions' image cleanup policy from Cloud Shell, which has no tools/firebase, with npx and an
// exact version (docs/OPERATIONS.md, Setting it up). That version must be the pinned CLI's.
describe("docs/OPERATIONS.md, the CLI version run by npx", () => {
  it("runs the version pinned in tools/firebase/package.json", () => {
    const pinned = JSON.parse(read("tools/firebase/package.json")).dependencies["firebase-tools"];
    const used = [...read("docs/OPERATIONS.md").matchAll(/npx -y firebase-tools@([^\s`]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const version of used) expect(version).toBe(pinned);
  });
});
