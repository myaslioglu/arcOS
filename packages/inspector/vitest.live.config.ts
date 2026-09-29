import { defineConfig } from "vitest/config";

// Node's fetch reads HTTPS_PROXY only when asked to (NODE_USE_ENV_PROXY, Node 22.21 and later), and the test workers inherit
// this process's environment, so it is set here: the suite then runs behind a proxy as well, and changes nothing without one.
process.env.NODE_USE_ENV_PROXY ??= "1";

/**
 * The live suite: read-only calls (eth_call, eth_getCode) to Arc mainnet's public RPC, run with
 * `npm run test:live -w @arcos/inspector`. The default config only includes `src/`, so `npm test` and CI never run it and
 * stay offline-stable. One worker, and the suite paces its own calls (see live/pools.live.test.ts).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["live/**/*.live.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
