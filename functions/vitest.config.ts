import { defineConfig } from "vitest/config";

// The unit tests: src/**/__tests__. The emulator suite (src/**/__emulator__) and the live suite (live/) have their own
// configs, so `npm test` needs neither the emulator nor the network.
export default defineConfig({ test: { environment: "node", include: ["src/**/__tests__/**/*.test.ts"] } });
