import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALLOWLIST, advisoryId, evaluate, isProdDependency, parseArgs, readAllowlist, rootAdvisories, runAudit } from "./audit.mjs";

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
  it("accepts the committed allowlist, every entry complete", () => {
    const list = readAllowlist(fs.readFileSync(path.join(root, DEFAULT_ALLOWLIST), "utf8"));
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) expect(Object.keys(e).sort()).toEqual(["id", "package", "reason", "until"]);
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

  it("calls npm ls without dev dependencies and reads an empty tree as dev-only", () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: JSON.stringify({ name: "arc-os" }), status: 0 };
    };
    expect(isProdDependency("braces", root, run)).toBe(false);
    expect(calls).toEqual([["npm", "ls", "--package-lock-only", "--omit=dev", "--json", "braces"]]);
    expect(isProdDependency("braces", root, stub(JSON.stringify({ name: "arc-os", dependencies: { "@arcos/web": {} } }), 0))).toBe(true);
    expect(isProdDependency("braces", root, stub(JSON.stringify({ name: "arc-os", dependencies: {} }), 0))).toBe(false);
  });
});

describe("parseArgs", () => {
  it("defaults to the committed allowlist and today", () => {
    const o = parseArgs([]);
    expect(o.allowlist).toBe(DEFAULT_ALLOWLIST);
    expect(o.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("takes --allowlist and --today, and rejects the rest", () => {
    expect(parseArgs(["--allowlist", "x.json", "--today", "2026-01-02"])).toEqual({ allowlist: "x.json", today: "2026-01-02" });
    expect(() => parseArgs(["--today", "yesterday"])).toThrow(/ISO date/);
    expect(() => parseArgs(["--verbose"])).toThrow(/unknown argument/);
  });
});
