import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ALLOWLIST,
  RUNTIME_REASON_MIN,
  advisoryId,
  entryPaths,
  evaluate,
  isCalendarDate,
  isProdDependency,
  normalizePrefix,
  parseArgs,
  readAllowlist,
  rootAdvisories,
  runAudit,
} from "./audit.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = "2026-10-03";

/** An advisory object the way `npm audit --json` lists it in a finding's `via`. */
const advisory = (name, id, severity = "high") => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} is vulnerable`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: "<=3.0.3",
});

/** The braces chain CI sees today: braces <- micromatch <- fast-glob <- @next/eslint-plugin-next <- eslint-config-next. */
const bracesChain = {
  braces: { name: "braces", severity: "high", isDirect: false, via: [advisory("braces", "GHSA-vfj7-8cjw-p6xm")], effects: ["micromatch"] },
  micromatch: { name: "micromatch", severity: "high", isDirect: false, via: ["braces"], effects: ["fast-glob"] },
  "fast-glob": { name: "fast-glob", severity: "high", isDirect: false, via: ["micromatch"], effects: ["@next/eslint-plugin-next"] },
  "@next/eslint-plugin-next": { name: "@next/eslint-plugin-next", severity: "high", isDirect: false, via: ["fast-glob"], effects: ["eslint-config-next"] },
  "eslint-config-next": { name: "eslint-config-next", severity: "high", isDirect: true, via: ["@next/eslint-plugin-next"], effects: [] },
};

const bracesEntry = { id: "GHSA-vfj7-8cjw-p6xm", package: "braces", reason: "dev-only lint chain; no fix published", until: "2026-11-03" };
const devOnly = () => false;
const inProd = () => true;

/** The braces chain the Firebase CLI's lockfile has: braces <- chokidar <- firebase-tools, a runtime dependency. */
const firebaseChain = {
  braces: { name: "braces", severity: "high", isDirect: false, via: [advisory("braces", "GHSA-vfj7-8cjw-p6xm")], effects: ["chokidar"] },
  chokidar: { name: "chokidar", severity: "high", isDirect: false, via: ["braces"], effects: ["firebase-tools"] },
  "firebase-tools": { name: "firebase-tools", severity: "high", isDirect: true, via: ["chokidar", advisory("firebase-tools", "GHSA-mmmm-mmmm-mmmm", "moderate")], effects: [] },
};
const runtimeReason = "the CLI globs only paths from this repo (firebase.json, our source); no untrusted pattern reaches braces";
const firebaseEntry = { ...bracesEntry, reason: runtimeReason, paths: ["tools/firebase"], runtime: true };

describe("evaluate", () => {
  it("allows the whole chain when its one advisory is allowlisted, dev-only and not expired, naming each finding and the reason", () => {
    const r = evaluate(bracesChain, [bracesEntry], { today: TODAY, isProd: devOnly });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.allowed.map((a) => a.name).sort()).toEqual(["@next/eslint-plugin-next", "braces", "eslint-config-next", "fast-glob", "micromatch"]);
    for (const a of r.allowed) expect(a).toMatchObject({ id: "GHSA-vfj7-8cjw-p6xm", package: "braces", reason: bracesEntry.reason, until: "2026-11-03" });
  });

  it("passes with nothing high or critical, allowlist or not", () => {
    const moderate = { lodash: { name: "lodash", severity: "moderate", via: [advisory("lodash", "GHSA-aaaa-bbbb-cccc", "moderate")], effects: [] } };
    expect(evaluate(moderate, [], { today: TODAY, isProd: devOnly })).toMatchObject({ ok: true, allowed: [], failures: [] });
    expect(evaluate({}, [bracesEntry], { today: TODAY, isProd: devOnly })).toMatchObject({ ok: true, allowed: [] });
  });

  it("fails on an unrelated high finding, and still reports the allowed chain", () => {
    const vulns = { ...bracesChain, ws: { name: "ws", severity: "high", isDirect: false, via: [advisory("ws", "GHSA-3h5v-q93c-6h6q")], effects: [] } };
    const r = evaluate(vulns, [bracesEntry], { today: TODAY, isProd: devOnly });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(["ws (high): GHSA-3h5v-q93c-6h6q (ws, high) is not allowlisted"]);
    expect(r.allowed).toHaveLength(5);
  });

  it("fails on a critical finding too", () => {
    const vulns = { ws: { name: "ws", severity: "critical", via: [advisory("ws", "GHSA-3h5v-q93c-6h6q", "critical")], effects: [] } };
    expect(evaluate(vulns, [bracesEntry], { today: TODAY, isProd: devOnly }).ok).toBe(false);
  });

  it("never allows a critical advisory, even one the allowlist names", () => {
    const vulns = { braces: { ...bracesChain.braces, severity: "critical", via: [advisory("braces", "GHSA-vfj7-8cjw-p6xm", "critical")] } };
    const r = evaluate(vulns, [bracesEntry, { ...bracesEntry, paths: ["."], runtime: true, reason: runtimeReason, id: "GHSA-vfj7-8cjw-p6xn" }], { today: TODAY, isProd: devOnly });
    expect(r.ok).toBe(false);
    expect(r.allowed).toEqual([]);
    expect(r.failures).toEqual(["braces (critical): GHSA-vfj7-8cjw-p6xm (braces) is critical, which the allowlist cannot cover"]);
  });

  it("fails a finding whose chain mixes an allowlisted advisory with one that is not", () => {
    const vulns = {
      ...bracesChain,
      micromatch: { ...bracesChain.micromatch, via: ["braces", advisory("micromatch", "GHSA-952p-6rrq-rcjv")] },
    };
    const r = evaluate(vulns, [bracesEntry], { today: TODAY, isProd: devOnly });
    expect(r.ok).toBe(false);
    // micromatch and everything above it fail; braces alone is allowed.
    expect(r.failures.map((f) => f.split(" ")[0]).sort()).toEqual(["@next/eslint-plugin-next", "eslint-config-next", "fast-glob", "micromatch"]);
    expect(r.failures[0]).toMatch(/GHSA-952p-6rrq-rcjv \(micromatch, high\) is not allowlisted/);
    expect(r.allowed.map((a) => a.name)).toEqual(["braces"]);
  });

  it("ignores an entry past its until date, says so, and fails the chain", () => {
    const r = evaluate(bracesChain, [bracesEntry], { today: "2026-11-04", isProd: devOnly });
    expect(r.ok).toBe(false);
    expect(r.expired).toEqual([bracesEntry]);
    expect(r.allowed).toEqual([]);
    expect(r.failures).toHaveLength(5);
    expect(r.failures[0]).toMatch(/GHSA-vfj7-8cjw-p6xm \(braces\) was allowlisted until 2026-11-03, which has passed/);
  });

  it("counts the until day itself", () => {
    expect(evaluate(bracesChain, [bracesEntry], { today: "2026-11-03", isProd: devOnly }).ok).toBe(true);
  });

  it("fails when the allowlisted package is reached from a production dependency, even with a valid entry", () => {
    const asked = [];
    const isProd = (pkg) => {
      asked.push(pkg);
      return pkg === "braces";
    };
    const r = evaluate(bracesChain, [bracesEntry], { today: TODAY, isProd });
    expect(r.ok).toBe(false);
    expect(r.allowed).toEqual([]);
    expect(r.failures).toHaveLength(5);
    expect(r.failures[0]).toMatch(/braces is reached from a production dependency/);
    expect(asked).toEqual(["braces"]); // asked once, not once per finding
  });

  it("fails when the entry's id is right but its package is another one", () => {
    const r = evaluate(bracesChain, [{ ...bracesEntry, package: "micromatch" }], { today: TODAY, isProd: devOnly });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/allowlisted for micromatch, but the advisory is about braces/);
  });

  it("does not let a moderate advisory in the chain block an otherwise allowed high finding", () => {
    const vulns = { ...bracesChain, micromatch: { ...bracesChain.micromatch, via: ["braces", advisory("micromatch", "GHSA-952p-6rrq-rcjv", "moderate")] } };
    expect(evaluate(vulns, [bracesEntry], { today: TODAY, isProd: devOnly }).ok).toBe(true);
  });
});

describe("evaluate: paths and runtime", () => {
  it("applies an entry without paths to the root alone", () => {
    expect(entryPaths(bracesEntry)).toEqual(["."]);
    expect(evaluate(bracesChain, [bracesEntry], { today: TODAY, isProd: devOnly }).ok).toBe(true);
    expect(evaluate(bracesChain, [bracesEntry], { today: TODAY, isProd: devOnly, prefix: "." }).ok).toBe(true);
    const r = evaluate(firebaseChain, [bracesEntry], { today: TODAY, isProd: devOnly, prefix: "tools/firebase" });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/GHSA-vfj7-8cjw-p6xm \(braces, high\) is not allowlisted/);
  });

  it("does not let an entry scoped to tools/firebase allow the root, nor a root entry allow tools/firebase", () => {
    const rootRun = evaluate(bracesChain, [firebaseEntry], { today: TODAY, isProd: devOnly, prefix: "." });
    expect(rootRun.ok).toBe(false);
    expect(rootRun.allowed).toEqual([]);
    expect(rootRun.expired).toEqual([]);
    const cliRun = evaluate(firebaseChain, [bracesEntry], { today: TODAY, isProd: inProd, prefix: "tools/firebase" });
    expect(cliRun.ok).toBe(false);
    expect(cliRun.failures).toHaveLength(3);
  });

  it("allows the Firebase CLI's chain only with runtime: true, and marks the allowance", () => {
    const strict = evaluate(firebaseChain, [{ ...firebaseEntry, runtime: false }], { today: TODAY, isProd: inProd, prefix: "tools/firebase" });
    expect(strict.ok).toBe(false);
    expect(strict.failures[0]).toMatch(/braces is reached from a production dependency/);
    const withoutField = evaluate(firebaseChain, [{ ...bracesEntry, paths: ["tools/firebase"] }], { today: TODAY, isProd: inProd, prefix: "tools/firebase" });
    expect(withoutField.ok).toBe(false);

    const asked = [];
    const r = evaluate(firebaseChain, [firebaseEntry], { today: TODAY, isProd: (p) => (asked.push(p), true), prefix: "tools/firebase" });
    expect(r.ok).toBe(true);
    expect(asked).toEqual([]); // the guard is skipped, not consulted and ignored
    expect(r.allowed.map((a) => a.name).sort()).toEqual(["braces", "chokidar", "firebase-tools"]);
    for (const a of r.allowed) expect(a).toMatchObject({ runtime: true, reason: runtimeReason });
  });

  it("marks a dev-only allowance runtime: false", () => {
    for (const a of evaluate(bracesChain, [bracesEntry], { today: TODAY, isProd: devOnly }).allowed) expect(a.runtime).toBe(false);
  });

  it("expires a scoped entry like a root one", () => {
    const r = evaluate(firebaseChain, [firebaseEntry], { today: "2026-11-04", isProd: inProd, prefix: "tools/firebase" });
    expect(r.ok).toBe(false);
    expect(r.expired).toEqual([firebaseEntry]);
  });

  it("lets the same advisory be listed for several roots, each on its own terms", () => {
    const list = readAllowlist(JSON.stringify([bracesEntry, firebaseEntry]));
    expect(evaluate(bracesChain, list, { today: TODAY, isProd: devOnly, prefix: "." }).ok).toBe(true);
    expect(evaluate(bracesChain, list, { today: TODAY, isProd: inProd, prefix: "." }).ok).toBe(false);
    expect(evaluate(firebaseChain, list, { today: TODAY, isProd: inProd, prefix: "tools/firebase" }).ok).toBe(true);
    expect(evaluate(firebaseChain, list, { today: TODAY, isProd: inProd, prefix: "functions/deploy" }).ok).toBe(false);
  });
});

describe("rootAdvisories and advisoryId", () => {
  it("follows the via chain to the advisory objects, once each, and survives a loop", () => {
    const vulns = {
      a: { name: "a", severity: "high", via: ["b", advisory("a", "GHSA-aaaa-aaaa-aaaa")] },
      b: { name: "b", severity: "high", via: ["a", advisory("b", "GHSA-bbbb-bbbb-bbbb")] },
    };
    expect(rootAdvisories("a", vulns).map(advisoryId).sort()).toEqual(["GHSA-aaaa-aaaa-aaaa", "GHSA-bbbb-bbbb-bbbb"]);
  });

  it("reads the id from the advisory url, or from github_advisory_id when npm gives one", () => {
    expect(advisoryId({ url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm" })).toBe("GHSA-vfj7-8cjw-p6xm");
    expect(advisoryId({ github_advisory_id: "GHSA-vfj7-8cjw-p6xm", url: "https://example.com" })).toBe("GHSA-vfj7-8cjw-p6xm");
    expect(advisoryId({ url: "https://npmjs.com/advisories/1234" })).toBeNull();
  });
});

describe("readAllowlist", () => {
  it("accepts the committed allowlist, every entry complete and scoped to one audit root", () => {
    const list = readAllowlist(fs.readFileSync(path.join(root, DEFAULT_ALLOWLIST), "utf8"));
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) {
      expect(Object.keys(e)).toEqual(expect.arrayContaining(["id", "package", "reason", "until", "paths"]));
      expect(e.paths).toHaveLength(1);
    }
  });

  it("accepts paths and runtime, and the same id for different roots", () => {
    expect(readAllowlist(JSON.stringify([bracesEntry, firebaseEntry]))).toHaveLength(2);
    expect(readAllowlist(JSON.stringify([{ ...bracesEntry, paths: [".", "functions/deploy"] }]))).toHaveLength(1);
  });

  it("rejects the same id twice for one root, with or without paths", () => {
    expect(() => readAllowlist(JSON.stringify([bracesEntry, bracesEntry]))).toThrow(/listed twice for the root/);
    expect(() => readAllowlist(JSON.stringify([bracesEntry, { ...bracesEntry, paths: ["tools/firebase", "."] }]))).toThrow(/listed twice for the root/);
    expect(() => readAllowlist(JSON.stringify([firebaseEntry, firebaseEntry]))).toThrow(/listed twice for tools\/firebase/);
  });

  it("rejects a runtime entry whose reason says too little, or whose runtime isn't a boolean", () => {
    expect(() => readAllowlist(JSON.stringify([{ ...firebaseEntry, reason: "it's fine" }]))).toThrow(new RegExp(`${RUNTIME_REASON_MIN} characters`));
    expect(() => readAllowlist(JSON.stringify([{ ...firebaseEntry, runtime: "yes" }]))).toThrow(/runtime/);
    expect(readAllowlist(JSON.stringify([{ ...firebaseEntry, runtime: false, reason: "short" }]))).toHaveLength(1);
  });

  it("rejects bad paths and unknown fields", () => {
    expect(() => readAllowlist(JSON.stringify([{ ...bracesEntry, paths: [] }]))).toThrow(/paths/);
    expect(() => readAllowlist(JSON.stringify([{ ...bracesEntry, paths: "tools/firebase" }]))).toThrow(/paths/);
    expect(() => readAllowlist(JSON.stringify([{ ...bracesEntry, paths: ["./tools/firebase/"] }]))).toThrow(/normalized/);
    expect(() => readAllowlist(JSON.stringify([{ ...bracesEntry, paths: ["../other"] }]))).toThrow(/inside the repository|normalized/);
    expect(() => readAllowlist(JSON.stringify([{ ...bracesEntry, note: "x" }]))).toThrow(/unknown field "note"/);
  });

  it("wants a real calendar date for until", () => {
    expect(isCalendarDate("2026-11-03")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-11-3", "2026-11-03T00:00:00Z", "soon"]) {
      expect(isCalendarDate(bad), bad).toBe(false);
      expect(() => readAllowlist(JSON.stringify([{ ...bracesEntry, until: bad }]))).toThrow(/calendar date/);
    }
  });

  it.each([
    ["not an array", "{}", /array/],
    ["a bad id", JSON.stringify([{ ...bracesEntry, id: "CVE-2024-1" }]), /GHSA id/],
    ["no reason", JSON.stringify([{ ...bracesEntry, reason: " " }]), /reason/],
    ["no until", JSON.stringify([{ id: bracesEntry.id, package: "braces", reason: "x" }]), /until/],
    ["a bad until", JSON.stringify([{ ...bracesEntry, until: "soon" }]), /until/],
    ["no package", JSON.stringify([{ ...bracesEntry, package: "" }]), /package/],
  ])("rejects %s", (_, json, message) => {
    expect(() => readAllowlist(json)).toThrow(message);
  });
});

describe("runAudit and isProdDependency, over a stubbed npm", () => {
  const stub = (stdout, status = 1) => () => ({ stdout, stderr: "", status });

  it("reads the report although npm audit exits 1 on findings", () => {
    const report = { auditReportVersion: 2, vulnerabilities: bracesChain, metadata: {} };
    expect(runAudit(root, stub(JSON.stringify(report), 1)).vulnerabilities).toEqual(bracesChain);
  });

  it("throws when npm audit prints no JSON or an error", () => {
    expect(() => runAudit(root, stub("npm ERR! network", 1))).toThrow(/no JSON/);
    expect(() => runAudit(root, stub(JSON.stringify({ error: { summary: "registry down" } }), 1))).toThrow(/registry down/);
    expect(() => runAudit(root, stub("{}", 0))).toThrow(/vulnerabilities/);
  });

  it("passes --prefix through to npm audit, and not for the root", () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: JSON.stringify({ vulnerabilities: {} }), status: 0 };
    };
    runAudit(root, run);
    runAudit(root, run, ".");
    runAudit(root, run, "tools/firebase");
    expect(calls).toEqual([
      ["npm", "audit", "--json", "--audit-level=high"],
      ["npm", "audit", "--json", "--audit-level=high"],
      ["npm", "audit", "--json", "--audit-level=high", "--prefix", "tools/firebase"],
    ]);
  });

  it("calls npm ls without dev dependencies, with --prefix when given, and reads an empty tree as dev-only", () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: JSON.stringify({ name: "arc-os" }), status: 0 };
    };
    expect(isProdDependency("braces", root, run)).toBe(false);
    expect(isProdDependency("braces", root, run, "tools/firebase")).toBe(false);
    expect(calls).toEqual([
      ["npm", "ls", "--package-lock-only", "--omit=dev", "--json", "braces"],
      ["npm", "ls", "--package-lock-only", "--omit=dev", "--json", "--prefix", "tools/firebase", "braces"],
    ]);
    expect(isProdDependency("braces", root, stub(JSON.stringify({ name: "arc-os", dependencies: { "@arcos/web": {} } }), 0))).toBe(true);
    expect(isProdDependency("braces", root, stub(JSON.stringify({ name: "arc-os", dependencies: {} }), 0))).toBe(false);
  });

  it("fails closed when npm ls cannot answer: an error, problems with the tree, or no JSON", () => {
    const enolock = { error: { code: "ENOLOCK", summary: "This command requires an existing lockfile.", detail: "..." } };
    expect(() => isProdDependency("braces", root, stub(JSON.stringify(enolock), 1))).toThrow(/requires an existing lockfile/);
    expect(() => isProdDependency("braces", root, stub(JSON.stringify({ name: "arc-os", problems: ["missing: braces@3.0.3"] }), 1))).toThrow(/problems/);
    expect(() => isProdDependency("braces", root, stub("npm ERR! boom", 1))).toThrow(/no JSON/);
    expect(isProdDependency("braces", root, stub(JSON.stringify({ name: "arc-os", problems: [] }), 0))).toBe(false);
  });
});

describe("parseArgs and normalizePrefix", () => {
  it("defaults to the committed allowlist, today and the root", () => {
    const o = parseArgs([]);
    expect(o.allowlist).toBe(DEFAULT_ALLOWLIST);
    expect(o.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(o.prefix).toBe(".");
  });
  it("takes --allowlist, --today and --prefix, and rejects the rest", () => {
    expect(parseArgs(["--allowlist", "x.json", "--today", "2026-01-02"], root)).toEqual({ allowlist: "x.json", today: "2026-01-02", prefix: "." });
    expect(parseArgs(["--prefix", "tools/firebase"], root).prefix).toBe("tools/firebase");
    expect(parseArgs(["--prefix", "./tools/firebase/"], root).prefix).toBe("tools/firebase");
    expect(parseArgs(["--prefix", path.join(root, "functions/deploy")], root).prefix).toBe("functions/deploy");
    expect(parseArgs(["--prefix", "."], root).prefix).toBe(".");
    expect(() => parseArgs(["--prefix", "../elsewhere"], root)).toThrow(/inside the repository/);
    expect(() => parseArgs(["--today", "yesterday"])).toThrow(/ISO date/);
    expect(() => parseArgs(["--verbose"])).toThrow(/unknown argument/);
  });
  it("normalizes a prefix to the form the allowlist uses", () => {
    expect(normalizePrefix("", root)).toBe(".");
    expect(normalizePrefix("tools/firebase", "/")).toBe("tools/firebase");
  });
});
