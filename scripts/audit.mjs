#!/usr/bin/env node
// The `npm audit` steps of CI, with an explicit, expiring allowlist:
//
//   node scripts/audit.mjs [--prefix <dir>] [--allowlist scripts/audit-allowlist.json] [--today YYYY-MM-DD]
//
// It runs `npm audit --json --audit-level=high` (in the repo root, or in --prefix's folder, which npm gets as its own
// --prefix) and fails (exit 1) on every high or critical finding, unless each high/critical advisory that finding comes
// from (its `via` chain, followed through the other findings down to the advisories themselves) is an entry of the
// allowlist that applies to this audit. An entry is one object:
//
//   { id, package, reason, until, paths?, runtime? }
//
// - id: the advisory's GHSA id (a high one: a critical advisory fails whatever the list says); package: the package the
//   advisory is about; reason: why it is tolerated.
// - until: the last day the entry counts (ISO date, inclusive). After that day the entry is ignored, and the finding
//   fails again, so the list cannot rot in silence.
// - paths: the audit roots the entry applies to ("." for the root lockfile, "tools/firebase", "functions/deploy").
//   Without it the entry applies to the root audit alone.
// - runtime: by default an allowlisted package must be a devDependency only: `npm ls --omit=dev <package>` (read from
//   the lockfile) has to come back empty, or the finding fails even though its advisory is allowlisted. `runtime: true`
//   skips that guard for this one entry, for a package that is a runtime dependency of what the lockfile installs, and
//   needs a reason that says why that exposure is acceptable there. Such an allowance is printed as a WARNING.
//
// Every allowance is printed with its reason, so a CI log says what was waved through and why.
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
/** A `runtime: true` entry's reason has to say something: this many characters at least. */
export const RUNTIME_REASON_MIN = 40;
export const ROOT = ".";

/** An audit root as the allowlist names it: relative to the repo root, forward slashes, "." for the root itself. */
export function normalizePrefix(prefix, root = process.cwd()) {
  const rel = path.relative(root, path.resolve(root, prefix)).split(path.sep).join("/");
  if (rel.startsWith("../") || rel === "..") throw new Error(`--prefix must be inside the repository, got ${prefix}`);
  return rel === "" ? ROOT : rel;
}

/** Whether a string is a real calendar date written YYYY-MM-DD (so 2026-02-30 and 2026-13-01 are not). */
export function isCalendarDate(text) {
  if (!DATE.test(text)) return false;
  const t = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === text;
}

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
    if (typeof entry.until !== "string" || !isCalendarDate(entry.until)) {
      throw new Error(`${where}: "until" must be a calendar date (YYYY-MM-DD)`);
    }
    if (entry.paths !== undefined) {
      if (!Array.isArray(entry.paths) || entry.paths.length === 0 || entry.paths.some((p) => typeof p !== "string" || !p)) {
        throw new Error(`${where}: "paths" must be a non-empty array of audit roots ("." or a folder)`);
      }
      for (const p of entry.paths) {
        if (p !== normalizePrefix(p, "/")) throw new Error(`${where}: "paths" entry ${JSON.stringify(p)} is not a normalized folder path ("." or "a/b")`);
      }
    }
    if (entry.runtime !== undefined && entry.runtime !== true && entry.runtime !== false) {
      throw new Error(`${where}: "runtime" must be true or false`);
    }
    if (entry.runtime === true && entry.reason.trim().length < RUNTIME_REASON_MIN) {
      throw new Error(`${where}: a "runtime" entry needs a "reason" of at least ${RUNTIME_REASON_MIN} characters saying why runtime exposure is acceptable`);
    }
    const known = ["id", "package", "reason", "until", "paths", "runtime"];
    for (const key of Object.keys(entry)) if (!known.includes(key)) throw new Error(`${where}: unknown field "${key}"`);
  });
  // One entry per advisory per audit root: a second one would be ignored by evaluate(), so it is refused instead.
  const seen = new Set();
  list.forEach((entry, i) => {
    for (const p of entryPaths(entry)) {
      const key = `${entry.id} ${p}`;
      if (seen.has(key)) throw new Error(`allowlist entry ${i + 1}: ${entry.id} is listed twice for ${p === ROOT ? "the root" : p}`);
      seen.add(key);
    }
  });
  return list;
}

/** The audit roots an entry applies to: its `paths`, or the root alone. */
export function entryPaths(entry) {
  return entry.paths ?? [ROOT];
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
 * The decision, from the audit report's `vulnerabilities`, the allowlist entries, the audit root being checked
 * (`prefix`, as the allowlist names it; the root when left out), today's date and a check of whether a package is
 * reached from a production dependency. Pure: it runs no command. Returns
 * { ok, allowed: [{ name, id, package, reason, until, runtime }], failures: [string], expired: [entry] }; `ok` is true
 * when no finding fails. Entries whose `paths` leave this audit root out are not consulted at all. The allowlist covers
 * high advisories only: a critical one fails whatever the list says.
 */
export function evaluate(vulnerabilities, allowlist, { today, isProd, prefix = ROOT }) {
  const active = new Map();
  const expired = [];
  for (const entry of allowlist) {
    if (!entryPaths(entry).includes(prefix)) continue;
    if (entry.until < today) expired.push(entry);
    else if (!active.has(entry.id)) active.set(entry.id, entry);
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
      if (advisory.severity === "critical") {
        reasons.push(`${id ?? advisory.url ?? "an advisory"} (${advisory.name}) is critical, which the allowlist cannot cover`);
      } else if (!entry) {
        reasons.push(
          expiredEntry
            ? `${id} (${advisory.name}) was allowlisted until ${expiredEntry.until}, which has passed`
            : `${id ?? advisory.url ?? "an advisory"} (${advisory.name}, ${advisory.severity}) is not allowlisted`,
        );
      } else if (entry.package !== advisory.name) {
        reasons.push(`${id} is allowlisted for ${entry.package}, but the advisory is about ${advisory.name}`);
      } else if (entry.runtime !== true && reachesProd(entry.package)) {
        reasons.push(`${id} is allowlisted for ${entry.package} as dev-only, but ${entry.package} is reached from a production dependency`);
      } else {
        allowances.push({ name, id, package: entry.package, reason: entry.reason, until: entry.until, runtime: entry.runtime === true });
      }
    }
    // A finding is allowed as a whole or fails as a whole: an allowance in a failing chain is not reported as allowed.
    if (reasons.length) failures.push(`${name} (${vuln.severity}): ${[...new Set(reasons)].join("; ")}`);
    else allowed.push(...allowances);
  }
  return { ok: failures.length === 0, allowed, failures, expired };
}

/** The --prefix arguments npm gets: none for the root audit. */
const prefixArgs = (prefix) => (prefix === ROOT ? [] : ["--prefix", prefix]);

/** `npm audit --json`, parsed. npm exits 1 when it finds anything, so the exit code is not the signal; the JSON is. */
export function runAudit(cwd, run = spawnSync, prefix = ROOT) {
  const r = run("npm", ["audit", "--json", "--audit-level=high", ...prefixArgs(prefix)], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
export function isProdDependency(pkg, cwd, run = spawnSync, prefix = ROOT) {
  const r = run("npm", ["ls", "--package-lock-only", "--omit=dev", "--json", ...prefixArgs(prefix), pkg], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  let tree;
  try {
    tree = JSON.parse(r.stdout);
  } catch {
    throw new Error(`npm ls --omit=dev ${pkg} printed no JSON (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  // An answer npm could not give is not "dev-only": a missing lockfile (ENOLOCK) or a tree with problems fails the run.
  if (tree.error) throw new Error(`npm ls --omit=dev ${pkg} failed: ${tree.error.summary ?? JSON.stringify(tree.error)}`);
  if (Array.isArray(tree.problems) && tree.problems.length > 0) {
    throw new Error(`npm ls --omit=dev ${pkg} reported problems with the tree:\n${tree.problems.join("\n")}`);
  }
  return Boolean(tree.dependencies && Object.keys(tree.dependencies).length > 0);
}

export function parseArgs(argv, cwd = process.cwd()) {
  const options = { allowlist: DEFAULT_ALLOWLIST, today: isoToday(), prefix: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allowlist" && argv[i + 1]) options.allowlist = argv[++i];
    else if (a === "--today" && argv[i + 1]) options.today = argv[++i];
    else if (a === "--prefix" && argv[i + 1]) options.prefix = normalizePrefix(argv[++i], cwd);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!DATE.test(options.today)) throw new Error(`--today must be an ISO date, got ${options.today}`);
  return options;
}

export function main(argv, io, cwd = process.cwd()) {
  let options;
  try {
    options = parseArgs(argv, cwd);
  } catch (e) {
    io.error(e.message);
    return 2;
  }
  const { prefix } = options;
  const where = prefix === ROOT ? "the root" : prefix;
  const allowlist = readAllowlist(fs.readFileSync(path.resolve(cwd, options.allowlist), "utf8"));
  const report = runAudit(cwd, spawnSync, prefix);
  const result = evaluate(report.vulnerabilities, allowlist, {
    today: options.today,
    prefix,
    isProd: (pkg) => isProdDependency(pkg, cwd, spawnSync, prefix),
  });
  const counts = report.metadata?.vulnerabilities;
  if (counts) io.log(`npm audit (${where}): ${counts.high ?? 0} high, ${counts.critical ?? 0} critical (${counts.total ?? 0} in all).`);
  for (const e of result.expired) io.log(`Allowlist entry ${e.id} (${e.package}) expired on ${e.until}: ignored.`);
  for (const a of result.allowed) {
    if (a.runtime) {
      io.log(`WARNING: ${a.name} via ${a.id} (${a.package}) is a RUNTIME dependency of ${where} and is allowed anyway until ${a.until} - ${a.reason}`);
    } else {
      io.log(`Allowed: ${a.name} via ${a.id} (${a.package}, dev-only) until ${a.until} - ${a.reason}`);
    }
  }
  if (!result.ok) {
    io.error(`npm audit (${where}): high/critical findings not covered by the allowlist:`);
    for (const f of result.failures) io.error(`  ${f}`);
    return 1;
  }
  io.log(result.allowed.length ? `npm audit (${where}): nothing high or critical outside the allowlist.` : `npm audit (${where}): nothing high or critical.`);
  return 0;
}

/** Whether this file is the one node was started with (not imported by a test). A path that can't be resolved is "no". */
function isInvoked() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvoked()) {
  process.exitCode = main(process.argv.slice(2), { log: console.log, error: console.error });
}
