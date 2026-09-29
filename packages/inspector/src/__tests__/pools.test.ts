import { describe, expect, it } from "vitest";
import { USDC, type DexConfig } from "@arcos/chain";
import { findPools } from "../checks";
import type { InspectInput } from "../types";
import { fakeChain, type FakeReader } from "./fixtures/chain-fake";

const TOKEN = "0x1111111111111111111111111111111111111111"; // sorts below USDC and EURC
const POOL = "0x7777777777777777777777777777777777777777";
const V2 = "0x5555555555555555555555555555555555555555";
const V3 = "0x6666666666666666666666666666666666666666";
const USD = { address: USDC, symbol: "USDC" };

const inputFor = (reader: FakeReader, dex: DexConfig, address: `0x${string}` = TOKEN): InspectInput => ({
  address, network: "mainnet", reader, explorer: null, dex, knownLockers: [], explorerBase: "https://explorer.test",
});

describe("a DEX config without Uniswap v2 or v3 (testnet has neither)", () => {
  it("asks only the factory it has: v3 alone", async () => {
    const chain = fakeChain({ reads: { [`${V3}.getPool(${TOKEN},${USDC},3000)`]: POOL, [`${USDC}.balanceOf(${POOL})`]: 5_000_000_000n } });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v3Factory: V3, v3FeeTiers: [3000] }));
    expect(scan.pools).toMatchObject([{ address: POOL, version: "v3", quote: "USDC", depth: 5_000_000_000n }]);
    expect(scan.factoriesAnswered).toBe(true);
    expect(chain.asked.map((r) => r.fn)).toEqual(["getPool", "balanceOf"]);
  });

  it("asks only the factory it has: v2 alone", async () => {
    const chain = fakeChain({ reads: { [`${V2}.getPair(${TOKEN},${USDC})`]: POOL, [`${USDC}.balanceOf(${POOL})`]: 5_000_000_000n } });
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v2Factory: V2 }));
    expect(scan.pools).toMatchObject([{ address: POOL, version: "v2", depth: 5_000_000_000n }]);
    expect(chain.asked.map((r) => r.fn)).toEqual(["getPair", "balanceOf"]);
  });

  it("asks no v3 question when the factory is named but no fee tier is", async () => {
    const chain = fakeChain();
    const scan = await findPools(inputFor(chain, { quoteTokens: [USD], v3Factory: V3 }));
    expect(scan.pools).toEqual([]);
    expect(chain.asked).toEqual([]);
  });
});
