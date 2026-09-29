import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLLECTIONS, DATABASE_ID, TTL_COLLECTIONS, TTL_FIELD } from "../names";
import { deployRequests, validateIndexesSpec } from "./helpers/firebase-tools";

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
  });

  it("does not index the TTL fields: nothing queries expiresAt, and Google advises exempting TTL fields", () => {
    for (const override of spec.fieldOverrides.filter((o) => o.ttl !== undefined)) {
      expect(override.indexes, override.collectionGroup).toEqual([]);
    }
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

  describe("what firebase deploy sends for it (firebase-tools' own deploy code, against a recording client)", () => {
    const base = `/projects/demo-arcos/databases/${DATABASE_ID}/collectionGroups`;

    it("sends every request to the arcos database: three reads, eight index creates, eight field patches, no deletes", async () => {
      const requests = await deployRequests(spec, DATABASE_ID);
      expect(requests.every((request) => request.url.includes(`/databases/${DATABASE_ID}`))).toBe(true);
      const count = (method: string) => requests.filter((request) => request.method === method).length;
      expect([count("GET"), count("POST"), count("PATCH"), count("DELETE")]).toEqual([3, 8, 8, 0]);
    });

    it("creates the eight composite indexes of design 1.6", async () => {
      const posts = (await deployRequests(spec, DATABASE_ID)).filter((request) => request.method === "POST");
      const sent = posts.map((post) => ({
        collectionGroup: post.url.slice(base.length + 1, -"/indexes".length),
        queryScope: (post.body as { queryScope: string }).queryScope,
        fields: (post.body as { fields: unknown }).fields,
      }));
      expect(sent.sort(byJson)).toEqual([...DESIGN_INDEXES].sort(byJson));
    });

    it("turns on TTL for each expiresAt with no single-field indexes, and exempts the three large fields", async () => {
      const patches = (await deployRequests(spec, DATABASE_ID)).filter((request) => request.method === "PATCH");
      const expected = [
        ...TTL_COLLECTIONS.map((collection) => ({
          method: "PATCH",
          url: `${base}/${collection}/fields/${TTL_FIELD}`,
          body: { indexConfig: { indexes: [] }, ttlConfig: {} },
        })),
        ...["alerts/fields/detail", "radarFeed/fields/rows", "reports/fields/report"].map((field) => ({
          method: "PATCH",
          url: `${base}/${field}`,
          body: { indexConfig: { indexes: [] } },
          queryParams: { updateMask: "indexConfig" },
        })),
      ];
      expect([...patches].sort(byJson)).toEqual(expected.sort(byJson));
    });
  });
});
