// Builds the functions codebase `arcos` into functions/deploy (design 1.3), the folder firebase.json deploys:
// 1. esbuild bundles src/index.ts and everything it imports (the @arcos packages, viem) into deploy/index.js. Only
//    firebase-functions and firebase-admin stay external: Cloud Build installs them from deploy/package.json and its
//    lockfile, with install scripts off (deploy/.npmrc).
// 2. firebase-functions' own discovery loads the bundle once, here, and writes what it declares to deploy/functions.yaml.
//    `firebase deploy` reads that file when it is there instead of loading the code itself, so the deploy job, which
//    holds the credential, runs none of the project's code (.github/workflows/deploy.yml).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
// `--out <dir>` builds somewhere else (the tests build into a temporary folder); the default is the deployed one.
const outAt = process.argv.indexOf("--out");
const deploy = outAt > 0 && process.argv[outAt + 1] ? path.resolve(process.argv[outAt + 1]) : path.join(root, "deploy");
const bundle = path.join(deploy, "index.js");
const manifest = path.join(deploy, "functions.yaml");

mkdirSync(deploy, { recursive: true });
rmSync(bundle, { force: true });
rmSync(manifest, { force: true });

await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["firebase-functions", "firebase-functions/*", "firebase-admin", "firebase-admin/*"],
  // Some bundled CommonJS code requires Node's built-ins; an ES module has no `require` of its own.
  banner: { js: 'import { createRequire as __arcosRequire } from "node:module"; const require = __arcosRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "info",
});

// The discovery binary takes its directory as the working directory (it reads "." unless given two arguments).
// Its package exports don't list the binary, so it is found from the package's own folder.
let sdk = path.dirname(createRequire(path.join(root, "package.json")).resolve("firebase-functions"));
while (!existsSync(path.join(sdk, "package.json")) || path.basename(sdk) !== "firebase-functions") sdk = path.dirname(sdk);
const bin = path.join(sdk, JSON.parse(readFileSync(path.join(sdk, "package.json"), "utf8")).bin["firebase-functions"]);
const discovered = spawnSync(process.execPath, [bin], {
  cwd: deploy,
  env: { ...process.env, FUNCTIONS_MANIFEST_OUTPUT_PATH: manifest, GCLOUD_PROJECT: "demo-arcos" },
  stdio: "inherit",
});
if (discovered.status !== 0) {
  console.error("Could not write deploy/functions.yaml");
  process.exit(1);
}
console.log(`Wrote ${path.relative(process.cwd(), bundle)} and ${path.relative(process.cwd(), manifest)}`);
