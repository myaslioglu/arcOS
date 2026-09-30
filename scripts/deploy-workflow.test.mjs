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
    expect(job("bundle")).not.toMatch(/^\s*environment:/m);
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

  it("never passes --force, which would skip a backend it can't find and still report success", () => {
    expect(deploy).not.toMatch(/(^|\s)--force\b(?!:)/m); // the comment that explains why not is allowed to name it
    expect(deploy.split("\n").filter((l) => /^\s*run:.*firebase/.test(l) && /--force/.test(l))).toEqual([]);
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
      expect(downs, "the deploy job downloads one bundle per site").toHaveLength(2);
      expect(up).toMatch(/apps\/web\/\.next\/static\n/);
      expect(up).toMatch(/apps\/web\/\.next\/server\n/);
      expect(up).not.toMatch(/scripts|\.github/); // scripts/ always comes from the deploy job's own checkout
      expect(up).toMatch(/retention-days: 1$/m);
      expect(up).toMatch(/if-no-files-found: error/);
      expect(up).toMatch(/include-hidden-files: true/); // the scan must see every file the build made
      expect(up.match(/^ {10}name: (.+)$/m)?.[1]).toBe("bundle-${{ matrix.site }}"); // the artifact's name, not the step's
      // By name, never by pattern: a missing bundle fails its download rather than being skipped.
      expect(downs.map((d) => d.match(/^ {10}name: (.+)$/m)?.[1])).toEqual(["bundle-mainnet", "bundle-testnet"]);
      for (const d of downs) expect(d).not.toMatch(/pattern:/);
    });

    it("downloads each bundle outside the workspace, which the CLI uploads as source, and scans both halves of each", () => {
      const downs = steps("deploy").filter((s) => /actions\/download-artifact@/.test(s));
      expect(downs[0]).toMatch(/^ {8}if: env\.DEPLOY_MAINNET == 'true'$/m);
      expect(downs[0]).toMatch(/path: \$\{\{ runner\.temp \}\}\/bundle-mainnet$/m);
      expect(downs[1]).toMatch(/^ {8}if: env\.DEPLOY_TESTNET == 'true'$/m);
      expect(downs[1]).toMatch(/path: \$\{\{ runner\.temp \}\}\/bundle-testnet$/m);
      const scan = runScripts(job("deploy")).find((r) => /scan-bundle/.test(r));
      expect(scan).toBe(
        [
          "dirs=()",
          'if [ "$DEPLOY_MAINNET" = true ]; then dirs+=("$RUNNER_TEMP/bundle-mainnet/static" "$RUNNER_TEMP/bundle-mainnet/server"); fi',
          'if [ "$DEPLOY_TESTNET" = true ]; then dirs+=("$RUNNER_TEMP/bundle-testnet/static" "$RUNNER_TEMP/bundle-testnet/server"); fi',
          'node scripts/scan-bundle.mjs "${dirs[@]}"',
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
  const MATRIX = `\${{ fromJSON(inputs.targets == 'mainnet' && '["mainnet"]' || inputs.targets == 'testnet' && '["testnet"]' || '["mainnet", "testnet"]') }}`;
  const deployStep = (id) => steps("deploy").find((s) => new RegExp(`^ {8}id: ${id}$`, "m").test(s));

  it("lets a manual run pick the sites, both by default, and a push has no choice: both", () => {
    const triggers = deploy.slice(deploy.indexOf("\non:"), deploy.indexOf("\nconcurrency:"));
    expect(triggers).toMatch(/ {6}targets:\n {8}description: .+\n {8}type: choice\n {8}options:\n {10}- both\n {10}- mainnet\n {10}- testnet\n {8}default: both\n/);
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

  it("deploys what it built: the deploy job's choice of sites is the matrix's", () => {
    // inputs.targets is '', 'both', 'mainnet' or 'testnet'. Each evaluates the same way in both places.
    const text = job("deploy");
    expect(text).toMatch(/^ {6}DEPLOY_MAINNET: \$\{\{ inputs\.targets != 'testnet' \}\}$/m);
    expect(text).toMatch(/^ {6}DEPLOY_TESTNET: \$\{\{ inputs\.targets != 'mainnet' \}\}$/m);
    const sites = (targets) => (targets === "mainnet" ? ["mainnet"] : targets === "testnet" ? ["testnet"] : ["mainnet", "testnet"]);
    for (const targets of ["", "both", "mainnet", "testnet"]) {
      const deployed = [...(targets !== "testnet" ? ["mainnet"] : []), ...(targets !== "mainnet" ? ["testnet"] : [])];
      expect(deployed, targets).toEqual(sites(targets));
    }
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
    const deploys = runScripts(job("deploy")).filter((r) => /firebase deploy/.test(r));
    expect(deploys).toHaveLength(2);
    for (const r of deploys) expect(r).toMatch(/--only "apphosting:\$\{APPHOSTING(_TESTNET)?_BACKEND\}"/);
    expect(deployCode).not.toMatch(/--only "?apphosting"?(\s|$)/);
  });

  it("tells the smoke job whether 4rc.OS's deploy succeeded, so a testnet failure after it doesn't skip its checks", () => {
    expect(job("deploy")).toMatch(/^ {4}outputs:\n {6}mainnet: \$\{\{ steps\.deploy-mainnet\.outcome \}\}$/m);
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
    for (const glob of workspaces) expect(glob, "a workspace glob").toMatch(/^(apps|packages)\/[^/]*$/);
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
    expect(ci).toMatch(/^ {8}run: npm audit --audit-level=high --prefix tools\/firebase$/m);
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
