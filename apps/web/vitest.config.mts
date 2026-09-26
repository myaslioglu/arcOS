import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // tsconfig.json keeps JSX as written ("preserve") because Next compiles it; tests that reach a .tsx module (the OG
  // image route and its card) need it compiled here instead.
  oxc: { jsx: { runtime: "automatic" } },
});
