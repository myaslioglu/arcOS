import { defineConfig } from "vitest/config";

// The emulator suite lives in src/__emulator__ and has its own config (vitest.emulator.config.ts), so this run only
// picks up the unit tests.
export default defineConfig({ test: { environment: "node", include: ["src/**/__tests__/**/*.test.ts"] } });
