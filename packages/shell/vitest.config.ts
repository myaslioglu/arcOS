import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  // Component tests reach .tsx modules: compile their JSX with the automatic runtime, as tsconfig's "react-jsx" does.
  oxc: { jsx: { runtime: "automatic" } },
});
