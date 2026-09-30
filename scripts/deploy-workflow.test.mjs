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
    expect(at("run: npm ci --ignore-scripts --prefix tools/firebase")).toBeGreaterThan(at("run: node scripts/scan-bundle.mjs"));
    expect(at("uses: google-github-actions/auth@")).toBeGreaterThan(at("run: npm ci --ignore-scripts --prefix tools/firebase"));
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
