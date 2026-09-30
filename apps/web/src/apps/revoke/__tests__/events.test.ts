import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where a revoke is counted. flow.test.ts drives the count itself: once per confirmed transaction that cleared an
 * approval, never for one already cleared (nothing was sent), a revert, or an allowance still set. This pins that the
 * count is made there alone, so no window or store counts the same revoke twice.
 */
describe("the revoke app counts revoke_success in flow.ts alone", () => {
  const dir = path.resolve(import.meta.dirname, "..");
  const sources = readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => [f, readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")] as const);

  it("makes exactly one trackEvent call, with no props, in flow.ts", () => {
    const calls = sources.flatMap(([file, source]) => [...source.matchAll(/\btrackEvent\(([^)]*)\)/g)].map((m) => [file, m[1]]));
    expect(calls).toEqual([["flow.ts", '"revoke_success"']]);
  });
});
