#!/usr/bin/env node
// Runs the forge binary that @foundry-rs/forge installed for this platform and exits with forge's own exit code.
// @foundry-rs/forge 1.7.1's bin.mjs (what `npx forge` and a bare `forge` in npm scripts run) never forwards the
// child's exit status, so a failing `forge test` or `forge build` still exits 0 through it, and CI stays green.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
const binary = process.platform === "win32" ? "forge.exe" : "forge";
const path = require.resolve(`@foundry-rs/forge-${process.platform}-${arch}/bin/${binary}`);
const result = spawnSync(path, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
