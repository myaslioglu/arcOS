import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The RPC provider's key (`INSPECT_RPC_KEY`, a runtime secret) must never reach a browser bundle: it is read in one
// server-only module, rpc-urls.ts, and that module is imported only from server-only modules. scripts/scan-bundle.mjs
// checks the built bundles for the key itself before every deploy (docs/DEPLOYING.md); this checks the sources it comes from.

const SRC = path.resolve(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const relative = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const serverOnly = (text: string) => /^import\s+["']server-only["'];?$/m.test(text);

describe("the RPC provider's key in the web app", () => {
  const files = sources(SRC).map((file) => ({ file: relative(file), text: readFileSync(file, "utf8") }));

  it("is read in rpc-urls.ts alone, which is server-only", () => {
    const readers = files.filter(({ text }) => /process\.env(\.INSPECT_RPC_KEY|\[["'`]INSPECT_RPC_KEY)/.test(text)).map(({ file }) => file);
    expect(readers).toEqual(["lib/rpc-urls.ts"]);
    expect(serverOnly(files.find(({ file }) => file === "lib/rpc-urls.ts")!.text)).toBe(true);
  });

  it("goes through no NEXT_PUBLIC_ setting, which the build would inline", () => {
    for (const { file, text } of files) expect(text, file).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(RPC|KEY|SECRET)/);
  });

  it("reaches the code only through server-only modules", () => {
    const importers = files.filter(({ text }) => /from\s+["'](\.\/|@\/lib\/)rpc-urls["']/.test(text));
    expect(importers.map(({ file }) => file)).toEqual(["lib/server-rpc.ts"]);
    for (const { file, text } of importers) {
      expect(serverOnly(text), file).toBe(true);
      expect(text.startsWith('"use client"'), file).toBe(false);
    }
  });
});
