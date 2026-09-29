import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { firebaseToolsDir } from "./helpers/firebase-tools";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const TOOLS = path.join(ROOT, "tools/firebase");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;

// One pinned Firebase CLI serves the tests, the emulator suite and the deploys: tools/firebase, with its own lockfile.
describe("the Firebase CLI these tests and the emulator suite use", () => {
  it("is the one in tools/firebase, at the version pinned there", () => {
    expect(firebaseToolsDir()).toBe(path.join(TOOLS, "node_modules/firebase-tools"));
    const pinned = json(path.join(TOOLS, "package.json")).dependencies?.["firebase-tools"];
    expect(json(path.join(firebaseToolsDir(), "package.json")).version).toBe(pinned);
  });

  it("is not a dependency of this package, so no workspace install pulls it in", () => {
    const pkg = json(path.join(ROOT, "packages/data/package.json"));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain("firebase-tools");
    const rootLock = json(path.join(ROOT, "package-lock.json")).packages ?? {};
    expect(Object.keys(rootLock).filter((name) => name.endsWith("node_modules/firebase-tools"))).toEqual([]);
  });

  it("runs the emulator suite through the tools/firebase binary", () => {
    const script = json(path.join(ROOT, "packages/data/package.json")).scripts?.["test:emulator"];
    expect(script).toMatch(/^\.\.\/\.\.\/tools\/firebase\/node_modules\/\.bin\/firebase emulators:exec --only firestore --project demo-arcos /);
  });
});
