import { describe, expect, it } from "vitest";
import { EURC, USDC } from "@arcos/chain";
import type { PoolSighting } from "../events";
import { quoteOf, selectPool } from "../pools";

const TOKEN = "0x470f09ae20163d5e243f6530fb328912a8fcb099";
const ZERO = "0x0000000000000000000000000000000000000000";
const usdc = USDC.toLowerCase() as `0x${string}`;
const eurc = EURC.mainnet.toLowerCase() as `0x${string}`;

const sighting = (over: Partial<PoolSighting>): PoolSighting => ({
  kind: "pool",
  version: "v3",
  id: "0x2982e0fed1815f130110b60c82339db9a4731677",
  currency0: usdc,
  currency1: TOKEN,
  fee: 10_000,
  tickSpacing: 200,
  hooks: null,
  block: 23_822_589,
  logIndex: 2,
  timestamp: 1_790_000_000,
  ...over,
});

describe("quoteOf", () => {
  it("knows USDC's ERC-20 view and EURC on every version, and native USDC on v4 only", () => {
    expect(quoteOf(usdc, "v2", "mainnet")).toBe("USDC");
    expect(quoteOf(USDC, "aero", "mainnet")).toBe("USDC");
    expect(quoteOf(eurc, "v3", "mainnet")).toBe("EURC");
    expect(quoteOf(ZERO, "v4", "mainnet")).toBe("USDC-native");
    expect(quoteOf(ZERO, "v3", "mainnet")).toBeNull();
    expect(quoteOf(TOKEN, "v4", "mainnet")).toBeNull();
    // The testnet EURC is another address: mainnet's isn't a quote there.
    expect(quoteOf(eurc, "v4", "testnet")).toBeNull();
    expect(quoteOf(EURC.testnet, "v4", "testnet")).toBe("EURC");
  });
});

describe("selectPool", () => {
  it("records a pool with USDC on one side, and makes the other side the token", () => {
    expect(selectPool(sighting({}), "mainnet")).toEqual({
      token: TOKEN,
      pool: {
        network: "mainnet", poolId: "0x2982e0fed1815f130110b60c82339db9a4731677", version: "v3", token: TOKEN, quote: "USDC",
        fee: 10_000, createdBlock: 23_822_589, key: null, depthUsdc: null, sampledAt: null,
      },
    });
  });

  it("finds the quote on either side", () => {
    expect(selectPool(sighting({ currency0: TOKEN, currency1: eurc }), "mainnet")).toMatchObject({ token: TOKEN, pool: { quote: "EURC" } });
  });

  it("keeps a v4 pool's whole key, the hook included, and names native USDC", () => {
    const hooks = "0x83139c02ee291298baef473a775c2e996c066044";
    const id = `0x${"9e".repeat(32)}`;
    expect(selectPool(sighting({ version: "v4", id, currency0: ZERO, hooks }), "mainnet")).toEqual({
      token: TOKEN,
      pool: {
        network: "mainnet", poolId: id, version: "v4", token: TOKEN, quote: "USDC-native", fee: 10_000, createdBlock: 23_822_589,
        key: { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks }, depthUsdc: null, sampledAt: null,
      },
    });
  });

  it("records nothing when neither side is a quote, or both are (no token to index)", () => {
    expect(selectPool(sighting({ currency0: TOKEN, currency1: "0x1111111111111111111111111111111111111111" }), "mainnet")).toBeNull();
    expect(selectPool(sighting({ currency0: usdc, currency1: eurc }), "mainnet")).toBeNull();
    expect(selectPool(sighting({ version: "v4", id: `0x${"01".repeat(32)}`, currency0: ZERO, currency1: usdc, hooks: ZERO }), "mainnet")).toBeNull();
  });

  it("refuses a v4 sighting without a tick spacing or a hook, which no Initialize log lacks", () => {
    expect(selectPool(sighting({ version: "v4", id: `0x${"02".repeat(32)}`, hooks: null }), "mainnet")).toBeNull();
  });
});
