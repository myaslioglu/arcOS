import { defineConfig } from "vitest/config";

// Runs only under `firebase emulators:exec` (npm run test:emulator -w @arcos/functions): src/__emulator__/setup.ts refuses
// to start anywhere else. The unit tests have their own config (vitest.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__emulator__/**/*.test.ts"],
    setupFiles: ["src/__emulator__/setup.ts"],
    // The Admin SDK asks the GCE metadata server for credentials before its first call, even against the emulator.
    env: { METADATA_SERVER_DETECTION: "none" },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
