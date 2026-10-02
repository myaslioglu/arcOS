#!/usr/bin/env node
// Checks that package-lock.json holds no WalletConnect or Reown package past the Apache-2.0 line.
//
//   node scripts/walletconnect-licence.mjs [package-lock.json]
//
// @walletconnect/ethereum-provider 2.21.8 is the last release under Apache-2.0. From 2.21.9 on, WalletConnect's monorepo
// packages ship under Reown's own community licence: a proprietary licence with usage thresholds that this MIT repo
// doesn't take on. @reown/appkit followed at 1.8.3 (1.8.0 to 1.8.2 are still Apache-2.0); this stops at 1.8.0 to be safe.
// wagmi 3 leaves the provider to the app (an optional peer), so a routine bump could pull the new licence in without any
// error. This fails instead, for any copy of either scope at any depth of the tree:
// - a licence field that is not a permissive open-source one, or none;
// - a package of WalletConnect's monorepo (core, sign-client, types, utils, universal-provider, ethereum-provider) at or
//   past 2.21.9. The other @walletconnect/* packages (logger, jsonrpc-*, ...) have version lines of their own, so for
//   them the licence field alone decides;
// - a @reown/* package at or past 1.8.0.
// The web suite runs it through scripts/walletconnect-licence.test.mjs.
//
// Exit codes: 0 nothing found; 1 a package is past the line; 2 the lockfile could not be read or holds no WalletConnect
// provider at all (so the check would have passed without looking).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Licence identifiers a package of either scope may carry. An SPDX expression passes when every identifier in it does. */
export const PERMISSIVE = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);

/** Where the version line applies: WalletConnect's monorepo packages, and all of @reown. */
const WALLETCONNECT_MONOREPO = new Set(["core", "sign-client", "types", "utils", "universal-provider", "ethereum-provider"]);

/** The first version this check refuses, for each scope. AppKit's relicensing began at 1.8.3; 1.8.0 leaves a margin. */
export const FIRST_RELICENSED = { "@walletconnect": [2, 21, 9], "@reown": [1, 8, 0] };

const SCOPED = /(?:^|\/)node_modules\/(@walletconnect|@reown)\/([^/]+)$/;

/** True when an SPDX licence expression names only permissive licences. */
export function isPermissive(license) {
  if (typeof license !== "string" || license.trim() === "") return false;
  const ids = license.replace(/[()]/g, " ").split(/\s+/).filter((t) => t && t !== "OR" && t !== "AND");
  return ids.length > 0 && ids.every((id) => PERMISSIVE.has(id));
}

/** [major, minor, patch] of a version, prerelease and build dropped; null when it isn't one. */
export function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atOrPast(version, line) {
  for (let i = 0; i < 3; i++) if (version[i] !== line[i]) return version[i] > line[i];
  return true;
}

/**
 * Every @walletconnect/* and @reown/* package in a parsed package-lock.json (lockfileVersion 2 or 3), and what is wrong
 * with each one that is past the line. `problems` is empty when the lockfile is fine.
 */
export function checkLockfile(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") throw new Error("not a package-lock.json with a packages map");
  const found = [];
  const problems = [];
  for (const [key, entry] of Object.entries(packages)) {
    const m = SCOPED.exec(key);
    if (!m) continue;
    const [, scope, name] = m;
    const id = `${scope}/${name}@${entry.version}`;
    found.push(id);
    if (!isPermissive(entry.license)) problems.push(`${key}: ${id} has licence ${JSON.stringify(entry.license ?? null)}`);
    if (scope === "@walletconnect" && !WALLETCONNECT_MONOREPO.has(name)) continue;
    const version = parseVersion(entry.version);
    if (!version) problems.push(`${key}: ${id} has a version this check can't read`);
    else if (atOrPast(version, FIRST_RELICENSED[scope])) {
      problems.push(`${key}: ${id} is at or past ${scope} ${FIRST_RELICENSED[scope].join(".")}, the line this check holds against Reown's licence`);
    }
  }
  return { found, problems };
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = argv[0] ?? path.join(root, "package-lock.json");
  let result;
  try {
    result = checkLockfile(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    console.error(`walletconnect-licence: ${file}: ${error.message}`);
    return 2;
  }
  if (!result.found.some((id) => id.startsWith("@walletconnect/ethereum-provider@"))) {
    console.error(`walletconnect-licence: ${file} holds no @walletconnect/ethereum-provider; nothing was checked`);
    return 2;
  }
  for (const p of result.problems) console.error(p);
  console.log(`walletconnect-licence: ${result.found.length} packages checked, ${result.problems.length} past the Apache-2.0 line`);
  return result.problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
