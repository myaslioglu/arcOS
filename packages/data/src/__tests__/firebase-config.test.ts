import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASE_ID } from "../names";
import { databasesDeployedBy, firebaseJsonProblems } from "./helpers/firebase-tools";
import { FUNCTIONS_ENTRY, FUNCTIONS_SOURCE, checkFunctions, scanExports } from "./helpers/functions-guard";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const config = JSON.parse(readFileSync(path.join(ROOT, "firebase.json"), "utf8")) as {
  firestore?: unknown;
  functions?: unknown;
};

describe("firebase.json: Firestore", () => {
  it("passes firebase-tools' own schema for the file", () => {
    expect(firebaseJsonProblems(config)).toEqual([]);
  });

  it("holds an array with exactly one database: the named database arcos", () => {
    // The array form keeps a deploy off (default). One entry, because the emulator loads the rules only for a single
    // entry (controller.js: "does not support multiple databases yet") and `firebase deploy` creates the first one.
    expect(Array.isArray(config.firestore)).toBe(true);
    expect(config.firestore).toEqual([
      { database: DATABASE_ID, rules: "firestore/arcos.rules", indexes: "firestore/arcos.indexes.json" },
    ]);
  });

  it("points at files that exist", () => {
    for (const file of ["firestore/arcos.rules", "firestore/arcos.indexes.json"]) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it("sends every deploy selection to arcos and nowhere else", () => {
    for (const only of [undefined, "firestore", "firestore:arcos", "firestore:rules", "firestore:indexes"]) {
      expect(databasesDeployedBy(config.firestore, only), String(only)).toEqual([DATABASE_ID]);
    }
    expect(() => databasesDeployedBy(config.firestore, "firestore:(default)")).toThrow(/Could not find configurations/);
  });
});

describe("firebase.json: functions", () => {
  it("has no functions entry outside the codebase arcos, and every exported function name starts with arcos", () => {
    const entry = path.join(ROOT, FUNCTIONS_ENTRY);
    // A missing entry file passes only while firebase.json has no functions entry; the check itself is tested below.
    const scan = existsSync(entry) ? scanExports(readFileSync(entry, "utf8")) : null;
    expect(checkFunctions(config, scan)).toEqual([]);
  });

  it("deploys the one codebase arcos, from the bundle folder, on Node 22, and exports the indexer by name", () => {
    expect(config.functions).toEqual([{ codebase: "arcos", source: FUNCTIONS_SOURCE, runtime: "nodejs22", ignore: ["node_modules"] }]);
    expect(scanExports(readFileSync(path.join(ROOT, FUNCTIONS_ENTRY), "utf8"))).toEqual({ names: ["arcosIndexer"], unresolved: [] });
  });

  describe("the check itself", () => {
    const arcos = { codebase: "arcos", source: "functions/deploy", runtime: "nodejs22" };
    const exports = (...names: string[]) => ({ names, unresolved: [] });

    it("accepts no functions at all, and one arcos entry as an array or as an object", () => {
      expect(checkFunctions({}, null)).toEqual([]);
      expect(checkFunctions({ functions: [arcos] }, exports("arcosIndexer", "arcosWatchdog"))).toEqual([]);
      expect(checkFunctions({ functions: arcos }, exports("arcosIndexer"))).toEqual([]);
    });

    it("fails closed when a functions entry is configured but its entry file is missing", () => {
      // With nothing to scan, an unprefixed export could still ship, so a missing entry is a problem, not a pass.
      const missing = [`functions entry configured but ${FUNCTIONS_ENTRY} not found`];
      expect(checkFunctions({ functions: [arcos] }, null)).toEqual(missing);
      expect(checkFunctions({ functions: arcos }, null)).toEqual(missing);
    });

    it("rejects another codebase, a missing codebase and a second entry", () => {
      expect(checkFunctions({ functions: [{ ...arcos, codebase: "other" }] }, exports())).toHaveLength(1);
      expect(checkFunctions({ functions: [{ source: "functions/deploy" }] }, exports())).toHaveLength(1);
      expect(checkFunctions({ functions: [arcos, arcos] }, exports())).toHaveLength(1);
    });

    it("rejects an entry whose source isn't the bundle built from the scanned entry file (design 1.3)", () => {
      // The names checked are read from FUNCTIONS_ENTRY; a deploy from any other source would ship names never read.
      expect(checkFunctions({ functions: [{ ...arcos, source: "functions" }] }, exports("arcosIndexer"))).toEqual([
        `functions[0].source must be "${FUNCTIONS_SOURCE}", not "functions"`,
      ]);
      expect(checkFunctions({ functions: { ...arcos, source: "functions/src" } }, exports("arcosIndexer"))).toEqual([
        `functions[0].source must be "${FUNCTIONS_SOURCE}", not "functions/src"`,
      ]);
      expect(checkFunctions({ functions: [{ codebase: "arcos" }] }, exports("arcosIndexer"))).toEqual([
        `functions[0].source must be "${FUNCTIONS_SOURCE}", not undefined`,
      ]);
      expect(checkFunctions({ functions: [{ ...arcos, source: "./functions/deploy" }] }, exports())).toHaveLength(1);
    });

    it("rejects an exported name without the prefix, case included", () => {
      expect(checkFunctions({ functions: [arcos] }, exports("arcosIndexer", "indexer", "ArcosX"))).toEqual([
        'the function "indexer" must have a name that starts with arcos',
        'the function "ArcosX" must have a name that starts with arcos',
      ]);
    });

    it("rejects export * and export default, which hide the name", () => {
      expect(checkFunctions({}, scanExports('export * from "./jobs";'))).toHaveLength(1);
      expect(checkFunctions({}, scanExports("export default function run() {}"))).toHaveLength(1);
    });
  });

  describe("scanExports", () => {
    it("reads consts, functions, aliases and re-exports, and skips types", () => {
      const scan = scanExports(`
        import { onSchedule } from "firebase-functions/v2/scheduler";
        export const arcosIndexer = onSchedule("every 1 minutes", async () => {}), arcosAlso = 1;
        export function arcosPlain() {}
        export { arcosWatchdog } from "./watchdog";
        export { local as arcosRenamed };
        export type Options = { retry: number };
        export interface Shape { a: string }
        export type { Elsewhere } from "./types";
        export * as arcosGroup from "./group";
        const local = 1;
      `);
      expect(scan).toEqual({
        names: ["arcosIndexer", "arcosAlso", "arcosPlain", "arcosWatchdog", "arcosRenamed", "arcosGroup"],
        unresolved: [],
      });
    });

    it("reports export * apart and names a default export", () => {
      expect(scanExports('export * from "./jobs";').unresolved).toEqual(['"./jobs"']);
      expect(scanExports("export default 1;").names).toEqual(["default"]);
    });
  });
});
