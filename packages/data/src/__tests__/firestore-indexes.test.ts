import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLLECTIONS, TTL_COLLECTIONS, TTL_FIELD } from "../names";
import { validateIndexesSpec } from "./helpers/firebase-tools";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
type Spec = {
  indexes: { collectionGroup: string; queryScope: string; fields: unknown[] }[];
  fieldOverrides: { collectionGroup: string; fieldPath: string; ttl?: unknown; indexes: unknown[] }[];
};
const spec = JSON.parse(readFileSync(path.join(ROOT, "firestore/arcos.indexes.json"), "utf8")) as Spec;

const asc = "ASCENDING";
const desc = "DESCENDING";
const composite = (collectionGroup: string, ...fields: [string, string][]) => ({
  collectionGroup,
  queryScope: "COLLECTION",
  fields: fields.map(([fieldPath, order]) => ({ fieldPath, order })),
});
const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const nameOf = (override: { collectionGroup: string; fieldPath: string }) => `${override.collectionGroup}.${override.fieldPath}`;

// Design 1.6, "Composite indexes".
const DESIGN_INDEXES = [
  composite("tokens", ["network", asc], ["firstSeen", desc]),
  composite("tokens", ["network", asc], ["radar.liquid", asc], ["firstSeen", desc]),
  composite("tokens", ["network", asc], ["radar.passing", asc], ["firstSeen", desc]),
  composite("tokens", ["network", asc], ["radar.liquid", asc], ["radar.passing", asc], ["firstSeen", desc]),
  composite("tokens", ["network", asc], ["inspect.state", asc], ["inspect.priority", desc], ["firstSeen", desc]),
  composite("alerts", ["network", asc], ["token", asc], ["createdAt", desc]),
  composite("watches", ["user", asc], ["createdAt", desc]),
  composite("deliveries", ["status", asc], ["createdAt", asc]),
];

// A TTL field keeps Firestore's default single-field indexes; the override adds the policy.
const DEFAULT_SINGLE_FIELD = [
  { order: "ASCENDING", queryScope: "COLLECTION" },
  { order: "DESCENDING", queryScope: "COLLECTION" },
  { arrayConfig: "CONTAINS", queryScope: "COLLECTION" },
];

describe("firestore/arcos.indexes.json", () => {
  it("is a spec firebase-tools accepts, with nothing else in the file", () => {
    expect(() => validateIndexesSpec(spec)).not.toThrow();
    expect(Object.keys(spec).sort()).toEqual(["fieldOverrides", "indexes"]);
  });

  it("holds the eight composite indexes of design 1.6", () => {
    expect([...spec.indexes].sort(byJson)).toEqual([...DESIGN_INDEXES].sort(byJson));
  });

  it("only indexes collections that exist", () => {
    const known = new Set<string>(Object.values(COLLECTIONS));
    for (const index of spec.indexes) expect(known.has(index.collectionGroup), index.collectionGroup).toBe(true);
  });

  it("puts a TTL policy on expiresAt of nonces, linkCodes, alerts, deliveries and reports, and on nothing else", () => {
    const ttl = spec.fieldOverrides.filter((override) => override.ttl !== undefined);
    expect(ttl.every((override) => override.ttl === true)).toBe(true);
    expect(ttl.map(nameOf).sort()).toEqual(TTL_COLLECTIONS.map((collection) => `${collection}.${TTL_FIELD}`).sort());
    for (const override of ttl) expect(override.indexes, override.collectionGroup).toEqual(DEFAULT_SINGLE_FIELD);
  });

  it("does not index reports.report, alerts.detail or radarFeed.rows", () => {
    const exempt = spec.fieldOverrides.filter((override) => override.ttl === undefined);
    expect(exempt.map(nameOf).sort()).toEqual(["alerts.detail", "radarFeed.rows", "reports.report"]);
    for (const override of exempt) expect(override.indexes, override.fieldPath).toEqual([]);
  });

  it("overrides each field once", () => {
    const keys = spec.fieldOverrides.map(nameOf);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
