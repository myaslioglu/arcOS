import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INDEXER_OPTIONS } from "../indexer/schedule";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const deployPackage = JSON.parse(read("deploy/package.json")) as { main: string; type: string; dependencies: Record<string, string>; engines: { node: string } };
const workspacePackage = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };

let out: string;
let manifest: {
  endpoints: Record<string, Record<string, unknown>>;
  params?: { name: string; type: string }[];
};
let bundle: string;

// The real build (scripts/build.mjs), into a temporary folder: the bundle, and the manifest firebase-functions writes
// from it, which is what `firebase deploy` reads. The folder is inside the workspace, where the bundle's two external
// packages resolve, as they do from functions/deploy.
beforeAll(() => {
  out = mkdtempSync(path.join(ROOT, ".bundle-test-"));
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build.mjs"), "--out", out], { cwd: ROOT, stdio: "pipe" });
  manifest = JSON.parse(readFileSync(path.join(out, "functions.yaml"), "utf8"));
  bundle = readFileSync(path.join(out, "index.js"), "utf8");
}, 60_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the built codebase", () => {
  it("declares only arcosIndexer, and every endpoint name starts with arcos", () => {
    expect(Object.keys(manifest.endpoints)).toEqual(["arcosIndexer"]);
    for (const name of Object.keys(manifest.endpoints)) expect(name.startsWith("arcos")).toBe(true);
  });

  it("deploys arcosIndexer with design 1.3's settings, the Blockscout key as its only secret, and no prompted params", () => {
    expect(manifest.endpoints.arcosIndexer).toMatchObject({
      platform: "gcfv2",
      region: [INDEXER_OPTIONS.region],
      availableMemoryMb: 512,
      timeoutSeconds: 120,
      maxInstances: 1,
      concurrency: 1,
      serviceAccountEmail: INDEXER_OPTIONS.serviceAccount,
      secretEnvironmentVariables: [{ key: "BLOCKSCOUT_API_KEY" }],
      scheduleTrigger: { schedule: "every 1 minutes", timeZone: "Etc/UTC", retryConfig: { retryCount: 0 } },
      entryPoint: "arcosIndexer",
    });
    // A param other than a secret would need a dotenv value or a prompt, and the CI deploy is non-interactive.
    expect((manifest.params ?? []).filter((p) => p.type !== "secret")).toEqual([]);
  });

  it("imports nothing at run time but firebase-functions, firebase-admin and Node's built-ins", () => {
    const imported = [...bundle.matchAll(/^import\b[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!);
    const external = imported.filter((id) => !id.startsWith("node:"));
    expect(external.length).toBeGreaterThan(0);
    for (const id of external) expect(id).toMatch(/^firebase-(functions|admin)(\/|$)/);
    expect(bundle).not.toMatch(/\brequire\(["']firebase-tools/);
  });
});

describe("functions/deploy/package.json", () => {
  it("is an ES module whose main is the bundle, for Node 22", () => {
    expect(deployPackage).toMatchObject({ type: "module", main: "index.js", engines: { node: "22" } });
  });

  it("pins the two external packages at the workspace's exact versions, and its lockfile resolves them", () => {
    expect(Object.keys(deployPackage.dependencies).sort()).toEqual(["firebase-admin", "firebase-functions"]);
    const lock = JSON.parse(read("deploy/package-lock.json")) as { packages: Record<string, { version?: string }> };
    for (const [name, version] of Object.entries(deployPackage.dependencies)) {
      expect(version).toBe(workspacePackage.dependencies[name]);
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });

  it("turns install scripts off for Cloud Build's install", () => {
    expect(read("deploy/.npmrc").split("\n")).toContain("ignore-scripts=true");
  });
});
