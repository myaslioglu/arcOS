import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// AGENTS.md: "@arcos/data/server" (the Admin SDK) is imported only from server code. In this app that means a module
// marked `import "server-only"`, which fails the build if a client component ever reaches it, or a route handler.

const SRC = path.resolve(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const importsDataServer = (text: string) => /from\s+["']@arcos\/data\/server["']|import\(\s*["']@arcos\/data\/server["']\s*\)/.test(text);

describe("@arcos/data/server in the web app", () => {
  const files = sources(SRC);

  it("is imported by the sign-in wiring", () => {
    const importers = files.filter((file) => importsDataServer(readFileSync(file, "utf8")));
    expect(importers.map((file) => path.relative(SRC, file))).toContain(path.join("lib", "auth-deps.ts"));
  });

  it("is imported only from server-only modules or route handlers", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!importsDataServer(text)) continue;
      const isRoute = /(^|\/)app\/.*\/route\.ts$/.test(path.relative(SRC, file).split(path.sep).join("/"));
      const serverOnly = /^import\s+["']server-only["'];?$/m.test(text);
      expect(isRoute || serverOnly, path.relative(SRC, file)).toBe(true);
      expect(text.startsWith('"use client"'), path.relative(SRC, file)).toBe(false);
    }
  });
});
