import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// If anything the pure entry loads reached for the Admin SDK, importing the entry would throw.
vi.mock("firebase-admin/app", () => {
  throw new Error("the pure entry loaded firebase-admin/app");
});
vi.mock("firebase-admin/firestore", () => {
  throw new Error("the pure entry loaded firebase-admin/firestore");
});
vi.mock("@google-cloud/firestore", () => {
  throw new Error("the pure entry loaded @google-cloud/firestore");
});

const SRC = path.resolve(import.meta.dirname, "..");
const PACKAGE_JSON = path.resolve(SRC, "..", "package.json");
const NOT_PURE = new Set(["server", "__tests__", "__emulator__"]);
const FORBIDDEN = /^(firebase-admin|firebase-functions|firebase-tools|firebase\/|@google-cloud\/)/;

/** Every source file of the pure entry: all of src/ except the server entry, the unit tests and the emulator suite. */
function pureSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return dir === SRC && NOT_PURE.has(name) ? [] : pureSources(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const specifiersOf = (file: string): string[] =>
  ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((reference) => reference.fileName);

describe("the pure entry, @arcos/data", () => {
  it("scans the files it means to", () => {
    const names = pureSources().map((file) => path.basename(file));
    expect(names).toEqual(expect.arrayContaining(["index.ts", "names.ts", "ids.ts", "amounts.ts", "docs.ts", "converters.ts"]));
  });

  it("imports nothing from the Admin SDK or any other Firebase package", () => {
    for (const file of pureSources()) {
      for (const specifier of specifiersOf(file)) {
        expect(FORBIDDEN.test(specifier), `${path.relative(SRC, file)} imports ${specifier}`).toBe(false);
      }
    }
  });

  it("does not reach into the server entry", () => {
    for (const file of pureSources()) {
      for (const specifier of specifiersOf(file).filter((s) => s.startsWith("."))) {
        expect(/(^|\/)server(\/|$)/.test(specifier), `${path.relative(SRC, file)} imports ${specifier}`).toBe(false);
      }
    }
  });

  it("loads with the Admin SDK unavailable", async () => {
    const entry = await import("../index");
    expect(typeof entry.tokenId).toBe("function");
    expect(entry.DATABASE_ID).toBe("arcos");
  });

  it("is one of exactly two entries of the package: the pure one and the server one", () => {
    const { exports } = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { exports: unknown };
    expect(exports).toEqual({ ".": "./src/index.ts", "./server": "./src/server/index.ts" });
  });
});
