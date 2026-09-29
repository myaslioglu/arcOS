import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    settings: { next: { rootDir: "apps/web/" } },
  },
  globalIgnores([
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/node_modules/**",
    "**/next-env.d.ts",
    ".superpowers/**",
    // The Solidity package's build output is not linted; its JS helper scripts (packages/contracts/scripts) are.
    "packages/contracts/out/**",
    "packages/contracts/cache/**",
    "packages/contracts/broadcast/**",
  ]),
]);

export default eslintConfig;
