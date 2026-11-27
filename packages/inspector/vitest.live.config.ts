import { defineConfig } from "vitest/config";

/**
 * The live suite: read-only calls (eth_call, eth_getCode, eth_getStorageAt) to Arc mainnet's public RPC and, in
 * live/chains.live.test.ts, to Ethereum, Base, Arbitrum One and OP Mainnet (each chain's endpoint is chosen in
 * live/chains.ts), plus Sourcify. Run it with `npm run test:live -w @arcos/inspector`. The default config only includes
 * `src/`, so `npm test` and CI never run it and stay offline-stable. One worker, and the suite paces its own calls (see
 * live/pools.live.test.ts).
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
