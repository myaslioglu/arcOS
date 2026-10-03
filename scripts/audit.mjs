#!/usr/bin/env node
// The root `npm audit` of CI, with an explicit, expiring allowlist:
//
//   node scripts/audit.mjs [--allowlist scripts/audit-allowlist.json] [--today YYYY-MM-DD]
//
// It runs `npm audit --json --audit-level=high` and fails (exit 1) on every high or critical finding, unless each
// high/critical advisory that finding comes from (its `via` chain, followed through the other findings down to the
// advisories themselves) is an entry of the allowlist. An entry is one object { id, package, reason, until }: the
// advisory's GHSA id, the package the advisory is about, why it is tolerated, and the last day it counts (ISO date,
// inclusive). After that day the entry is ignored, and the finding fails again, so the list cannot rot in silence.
// An allowlisted package must also be a devDependency only: `npm ls --omit=dev <package>` (read from the lockfile)
// has to come back empty, or the finding fails even though its advisory is allowlisted. Every allowance is printed with
// its reason, so a CI log says what was waved through and why.
//
// This is for advisories without a published fix, which an `overrides` entry in package.json cannot settle. A finding
// that has a fix is still fixed by updating.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ALLOWLIST = "scripts/audit-allowlist.json";
const FAILING = new Set(["high", "critical"]);
const GHSA = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as an ISO date (UTC), for the `until` comparison. */
export function isoToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Checks the allowlist's shape and throws on anything that isn't an entry as documented above. Returns the entries.
 */
export function readAllowlist(json) {
  const list = typeof json === "string" ? JSON.parse(json) : json;
  if (!Array.isArray(list)) throw new Error("the allowlist must be a JSON array of entries");
  list.forEach((entry, i) => {
    const where = `allowlist entry ${i + 1}`;
    if (!entry || typeof entry !== "object") throw new Error(`${where} is not an object`);
    if (typeof entry.id !== "string" || !GHSA.test(entry.id)) throw new Error(`${where}: "id" must be a GHSA id`);
    if (typeof entry.package !== "string" || !entry.package) throw new Error(`${where}: "package" must be a package name`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error(`${where}: "reason" must say why`);
    if (typeof entry.until !== "string" || !DATE.test(entry.until) || Number.isNaN(Date.parse(entry.until))) {
      throw new Error(`${where}: "until" must be an ISO date (YYYY-MM-DD)`);
    }
  });
  return list;
}

/** The GHSA id of an advisory object from the audit JSON, from its url (or its github_advisory_id when present). */
export function advisoryId(advisory) {
  if (typeof advisory.github_advisory_id === "string") return advisory.github_advisory_id;
  const m = typeof advisory.url === "string" && advisory.url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return m ? m[0] : null;
}

/**
 * The high/critical advisories a finding comes from: the advisory objects in its own `via`, plus those of every finding
 * its `via` names, recursively. Each advisory is listed once; a chain that loops is followed once.
 */
export function rootAdvisories(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const vuln = vulnerabilities[name];
  if (!vuln) return [];
  const out = [];
  for (const via of vuln.via ?? []) {
    if (typeof via === "string") {
      out.push(...rootAdvisories(via, vulnerabilities, seen));
    } else if (via && typeof via === "object" && FAILING.has(via.severity)) {
      out.push(via);
    }
  }
  return out;
}

/**
 * The decision, from the audit report's `vulnerabilities`, the allowlist entries, today's date and a check of whether
 * a package is reached from a production dependency. Pure: it runs no command. Returns
 * { ok, allowed: [{ name, id, package, reason, until }], failures: [string] }; `ok` is true when no finding fails.
 */
export function evaluate(vulnerabilities, allowlist, { today, isProd }) {
  const active = new Map();
  const expired = [];
  for (const entry of allowlist) {
    if (entry.until < today) expired.push(entry);
    else active.set(entry.id, entry);
  }
  const allowed = [];
  const failures = [];
  const prodChecked = new Map();
  const reachesProd = (pkg) => {
    if (!prodChecked.has(pkg)) prodChecked.set(pkg, isProd(pkg));
    return prodChecked.get(pkg);
  };

  for (const [name, vuln] of Object.entries(vulnerabilities ?? {})) {
    if (!FAILING.has(vuln.severity)) continue;
    const roots = rootAdvisories(name, vulnerabilities);
    const reasons = [];
    const allowances = [];
    if (roots.length === 0) {
      reasons.push(`${vuln.severity} finding with no advisory of that level in its chain (a report shape this script doesn't know)`);
    }
    for (const advisory of roots) {
      const id = advisoryId(advisory);
      const entry = id ? active.get(id) : undefined;
      const expiredEntry = id ? expired.find((e) => e.id === id) : undefined;
      if (!entry) {
        reasons.push(
          expiredEntry
            ? `${id} (${advisory.name}) was allowlisted until ${expiredEntry.until}, which has passed`
            : `${id ?? advisory.url ?? "an advisory"} (${advisory.name}, ${advisory.severity}) is not allowlisted`,
        );
      } else if (entry.package !== advisory.name) {
        reasons.push(`${id} is allowlisted for ${entry.package}, but the advisory is about ${advisory.name}`);
      } else if (reachesProd(entry.package)) {
        reasons.push(`${id} is allowlisted for ${entry.package} as dev-only, but ${entry.package} is reached from a production dependency`);
      } else {
        allowances.push({ name, id, package: entry.package, reason: entry.reason, until: entry.until });
      }
    }
    // A finding is allowed as a whole or fails as a whole: an allowance in a failing chain is not reported as allowed.
    if (reasons.length) failures.push(`${name} (${vuln.severity}): ${[...new Set(reasons)].join("; ")}`);
    else allowed.push(...allowances);
  }
  return { ok: failures.length === 0, allowed, failures, expired };
}

/** `npm audit --json`, parsed. npm exits 1 when it finds anything, so the exit code is not the signal; the JSON is. */
export function runAudit(cwd, run = spawnSync) {
  const r = run("npm", ["audit", "--json", "--audit-level=high"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error(`npm audit printed no JSON (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  if (report.error) throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  if (!report.vulnerabilities) throw new Error(`npm audit printed a report without "vulnerabilities" (exit ${r.status})`);
  return report;
}

/**
 * Whether a package is reached from a production (non-dev) dependency, per the lockfile: `npm ls --omit=dev <pkg>`
 * lists the paths to it, and comes back with no "dependencies" when there are none.
 */
export function isProdDependency(pkg, cwd, run = spawnSync) {
  const r = run("npm", ["ls", "--package-lock-only", "--omit=dev", "--json", pkg], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  let tree;
  try {
    tree = JSON.parse(r.stdout);
  } catch {
    throw new Error(`npm ls --omit=dev ${pkg} printed no JSON (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  return Boolean(tree.dependencies && Object.keys(tree.dependencies).length > 0);
}

export function parseArgs(argv) {
  const options = { allowlist: DEFAULT_ALLOWLIST, today: isoToday() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allowlist" && argv[i + 1]) options.allowlist = argv[++i];
    else if (a === "--today" && argv[i + 1]) options.today = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!DATE.test(options.today)) throw new Error(`--today must be an ISO date, got ${options.today}`);
  return options;
}

export function main(argv, io, cwd = process.cwd()) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    io.error(e.message);
    return 2;
  }
  const allowlist = readAllowlist(fs.readFileSync(path.resolve(cwd, options.allowlist), "utf8"));
  const report = runAudit(cwd);
  const result = evaluate(report.vulnerabilities, allowlist, {
    today: options.today,
    isProd: (pkg) => isProdDependency(pkg, cwd),
  });
  const counts = report.metadata?.vulnerabilities;
  if (counts) io.log(`npm audit: ${counts.high ?? 0} high, ${counts.critical ?? 0} critical (${counts.total ?? 0} in all).`);
  for (const e of result.expired) io.log(`Allowlist entry ${e.id} (${e.package}) expired on ${e.until}: ignored.`);
  for (const a of result.allowed) {
    io.log(`Allowed: ${a.name} via ${a.id} (${a.package}, dev-only) until ${a.until} - ${a.reason}`);
  }
  if (!result.ok) {
    io.error("npm audit: high/critical findings not covered by the allowlist:");
    for (const f of result.failures) io.error(`  ${f}`);
    return 1;
  }
  io.log(result.allowed.length ? "npm audit: nothing high or critical outside the allowlist." : "npm audit: nothing high or critical.");
  return 0;
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  process.exitCode = main(process.argv.slice(2), { log: console.log, error: console.error });
}
