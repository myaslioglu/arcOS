import { defineConfig } from "vitest/config";

/**
 * The live suite: three read-only calls to Arc mainnet's public RPC (eth_getBlockByNumber and two eth_getLogs), run with
 * `npm run test:live -w @arcos/functions`. Never part of `npm test` or CI. Behind an HTTP proxy, set NODE_USE_ENV_PROXY=1.
 */
export default defineConfig({
  test: { environment: "node", include: ["live/**/*.live.test.ts"], fileParallelism: false, testTimeout: 120_000 },
});
