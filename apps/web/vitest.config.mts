import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // The deploy workflow's helper scripts (repo-root scripts/) are plain Node modules; their tests run in this suite,
  // which CI already runs, rather than in a suite of their own.
  test: { environment: "node", include: ["src/**/*.test.ts", "../../scripts/**/*.test.mjs"] },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // tsconfig.json keeps JSX as written ("preserve") because Next compiles it; tests that reach a .tsx module (the OG
  // image route and its card) need it compiled here instead.
  oxc: { jsx: { runtime: "automatic" } },
});
