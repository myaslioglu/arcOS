/**
 * Live, read-only checks of the Inspector's registry entries for Ethereum, Base, Arbitrum One and OP Mainnet: every
 * pinned address against the chain itself, the trade check's USDC funding, each chain's out-of-gas answer, Sourcify, and
 * a whole inspection of a few tokens per chain, printed as a coverage table. Not part of CI: run with
 * `npm run test:live -w @arcos/inspector -- chains` (see live/chains.ts for the endpoints it reads; with
 * `INSPECT_RPC_KEY` set it reads Alchemy, the key in a header). The Blockscout PRO case needs `BLOCKSCOUT_API_KEY` and is
 * skipped without it.
 *
 * Market state moves: a token below records what it showed when it was picked (2026-11-27). The addresses and the shapes
 * should keep answering the same way.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, parseAbi, type Address } from "viem";
import { INSPECT_CHAINS, MULTICALL3, type DexConfig, type InspectChain } from "@arcos/chain";
import { chainInput } from "../src/chain-input";
import { findPools } from "../src/checks";
import { blockscoutSource } from "../src/explorer";
import { proExplorerApi } from "../src/explorer-api";
import { inspect } from "../src/inspect";
import { isOutOfGas } from "../src/rpc-errors";
import { STATUS, simulateTrade, simulatorAddresses, tradeSetup } from "../src/simulate";
import { sourcifySource } from "../src/sourcify";
import type { InspectInput } from "../src/types";
import { live, via } from "./chains";

const OTHERS = INSPECT_CHAINS.mainnet.filter((c) => c.key !== "arc");
const lower = (a: string) => a.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

const views = parseAbi([
  "function poolManager() view returns (address)",
  "function factory() view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function getPool(address,address,uint24) view returns (address)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const slipstream = parseAbi(["function tickSpacings() view returns (int24[])"]);
const solidly = parseAbi(["function getPool(address,address,bool) view returns (address)", "function isPool(address) view returns (bool)"]);

/** Tokens per chain for the coverage table: USDC, WETH, and one token with a deep market of its own. */
const TOKENS: Record<string, Record<string, Address>> = {
  ethereum: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", PEPE: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" },
  base: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", WETH: "0x4200000000000000000000000000000000000006", DEGEN: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
  arbitrum: { USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548" },
  optimism: { USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", WETH: "0x4200000000000000000000000000000000000006", OP: "0x4200000000000000000000000000000000000042" },
};

/** Every address an entry names that must hold code. */
function addressesOf(c: InspectChain): [string, Address][] {
  const d = c.dex!;
  return [
    ...d.quoteTokens.map((q): [string, Address] => [q.symbol, q.address]),
    ["Uniswap v2 factory", d.v2Factory!],
    ["Uniswap v3 factory", d.v3Factory!],
    ...Object.entries(d.v4!).map(([k, a]): [string, Address] => [`Uniswap v4 ${k}`, a]),
    ...(d.aero ? ([["Slipstream factory", d.aero.clFactory], ["Slipstream position manager", d.aero.positionManager]] as [string, Address][]) : []),
    ...(d.solidly ? ([["classic factory", d.solidly.factory]] as [string, Address][]) : []),
    ["Multicall3", MULTICALL3],
  ];
}

describe.each(OTHERS.map((c) => [c.name, c] as const))("%s, live", (_, chain) => {
  const { client, reader, counted } = live(chain);
  const dex = chain.dex!;
  const usdc = dex.quoteTokens[0]!.address;
  const weth = dex.quoteTokens.find((q) => q.symbol === "WETH")!.address;
  const read = (address: Address, abi: Parameters<typeof reader.read>[1], fn: string, args: unknown[] = []) => reader.read(address, abi, fn, args);

  it(`reads through ${via(chain)}: the chain id is the registry's`, async () => {
    expect(await client.getChainId()).toBe(chain.chainId);
  });

  it("has code at every address the registry names", async () => {
    for (const [name, address] of addressesOf(chain)) expect(await reader.getCode(address), `${name} ${address}`).not.toBeNull();
  });

  it("names each quote token by its own symbol and decimals", async () => {
    for (const q of dex.quoteTokens) {
      expect(Number(await read(q.address, views, "decimals")), q.symbol).toBe(q.decimals);
      // Arbitrum's USDT calls itself USD₮0; the registry writes it in plain letters.
      const symbol = (await read(q.address, views, "symbol")) as string;
      expect(symbol === q.symbol || (chain.key === "arbitrum" && q.symbol === "USDT" && symbol === "USD₮0"), `${q.symbol}: ${symbol}`).toBe(true);
    }
  });

  it("pins Uniswap v4: the PositionManager, StateView and V4Quoter each name the PoolManager", async () => {
    const v4 = dex.v4!;
    for (const at of [v4.positionManager, v4.stateView, v4.quoter]) expect(lower((await read(at, views, "poolManager")) as string), at).toBe(lower(v4.poolManager));
  });

  it("pins Uniswap v2 and v3: the USDC/WETH pools they name have the factory as their own", async () => {
    const pair = (await read(dex.v2Factory!, views, "getPair", [usdc, weth])) as Address;
    expect(lower((await read(pair, views, "factory")) as string)).toBe(lower(dex.v2Factory!));
    for (const fee of dex.v3FeeTiers!) {
      const pool = (await read(dex.v3Factory!, views, "getPool", [usdc, weth, fee])) as Address;
      expect(pool, `fee ${fee}`).not.toBe(ZERO);
      expect(lower((await read(pool, views, "factory")) as string), `fee ${fee}`).toBe(lower(dex.v3Factory!));
    }
  });

  it.runIf(Boolean(dex.aero))("pins Slipstream: its position manager's factory, and the tick spacings the factory has enabled", async () => {
    const aero = dex.aero!;
    expect(lower((await read(aero.positionManager, views, "factory")) as string)).toBe(lower(aero.clFactory));
    const enabled = (await read(aero.clFactory, slipstream, "tickSpacings")) as readonly number[];
    expect([...enabled].map(Number).sort((a, b) => a - b)).toEqual(aero.tickSpacings);
  });

  it.runIf(Boolean(dex.solidly))("pins the classic factory: its USDC/WETH pools, volatile and stable, are its own", async () => {
    const factory = dex.solidly!.factory;
    for (const stable of [false, true]) {
      const pool = (await read(factory, solidly, "getPool", [usdc, weth, stable])) as Address;
      expect(pool, `stable ${stable}`).not.toBe(ZERO);
      expect(lower((await read(pool, views, "factory")) as string)).toBe(lower(factory));
      expect(await read(factory, solidly, "isPool", [pool])).toBe(true);
    }
  });

  it("funds USDC at slot 9: under the state override, balanceOf(S) is the amount written", async () => {
    const { simulator: s } = simulatorAddresses();
    const amount = 123_456_789n;
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [s, BigInt(chain.tradeQuote!.balanceSlot!)]));
    const data = encodeFunctionData({ abi: views, functionName: "balanceOf", args: [s] });
    const answer = await reader.callWithOverride({ from: s, to: chain.tradeQuote!.token, data, gas: 200_000n, gasPrice: 0n }, [
      { address: chain.tradeQuote!.token, stateDiff: [{ slot, value: numberToHex(amount, { size: 32 }) }] },
    ]);
    expect(BigInt(answer)).toBe(amount);
  });

  it("answers an eth_call that runs out of its own gas in one of the chain's out-of-gas shapes, and a too-low limit in none", async () => {
    const { simulator: s } = simulatorAddresses();
    const LOOP = "0x5b600056"; // JUMPDEST PUSH1 0 JUMP: runs until the gas is gone
    const request = client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<unknown>;
    const call = (gas: number) => request({ method: "eth_call", params: [{ from: s, to: s, gas: `0x${gas.toString(16)}`, data: "0x" }, "latest", { [s]: { code: LOOP } }] });
    const outOfGas = await call(100_000).catch((e: unknown) => e);
    expect(isOutOfGas(outOfGas, chain.outOfGas)).toBe(true);
    const tooLow = await call(20_000).catch((e: unknown) => e);
    expect(tooLow).toBeInstanceOf(Error);
    expect(isOutOfGas(tooLow, chain.outOfGas)).toBe(false);
  });

  it("round-trips WETH through its deepest USDC Uniswap v3 pool for under 1%", async () => {
    const v3Only: DexConfig = { quoteTokens: [dex.quoteTokens[0]!], v3Factory: dex.v3Factory, v3FeeTiers: dex.v3FeeTiers };
    const input: InspectInput = { ...chainInput(chain), dex: v3Only, address: weth, network: "mainnet", reader, explorer: null };
    const scan = await findPools(input);
    const run = await simulateTrade(reader, weth, scan, tradeSetup(input)!, Date.now() + 60_000);
    const first = run.kind === "measured" ? run.attempts[0] : undefined;
    if (first?.kind !== "ran") throw new Error(`no round trip: ${first?.kind ?? run.kind}`);
    const r = first.result;
    expect(r.status).toBe(STATUS.ok);
    const lossPpm = r.received >= r.spent ? 0n : ((r.spent - r.received) * 1_000_000n) / r.spent;
    console.log(`${chain.key}: WETH round trip in ${first.pool.address} (fee ${first.pool.fee}): ${r.spent} USDC units in, ${r.received} out, loss ${lossPpm} ppm`);
    expect(lossPpm).toBeLessThan(10_000n);
  });

  it("finds USDC verified on Sourcify", async () => {
    expect(await sourcifySource(chain.chainId).verified(usdc)).toBe(true);
  });

  it.runIf(Boolean(process.env.BLOCKSCOUT_API_KEY?.trim()))("reaches Blockscout's PRO API for the chain id", async () => {
    const api = proExplorerApi(chain.chainId, process.env.BLOCKSCOUT_API_KEY)!;
    const token = await blockscoutSource(api.url, fetch, api.apiKey).token(usdc);
    expect(token?.symbol).toBe("USDC");
  });

  it("inspects USDC, WETH and a token of its own: the coverage of each check, printed", async () => {
    const rows: string[] = [];
    for (const [label, address] of Object.entries(TOKENS[chain.key]!)) {
      counted();
      const report = await inspect({
        ...chainInput(chain),
        address,
        network: "mainnet",
        reader,
        explorer: null,
        explorerSkipped: "No explorer key in the live suite.",
        verifyFallback: sourcifySource(chain.chainId),
        deadlineAt: Date.now() + 120_000,
      });
      expect(report).toMatchObject({ chain: chain.key, chainId: chain.chainId, total: 9 });
      const requests = counted();
      const total = Object.values(requests).reduce((a, b) => a + b, 0);
      rows.push(`${chain.key} ${label}: ${report.findings.map((f) => `${f.id}=${f.status}`).join(" ")} | ${total} RPC requests ${JSON.stringify(requests)}`);
      for (const f of report.findings) rows.push(`  ${f.id} [${f.status}] ${f.title}: ${f.detail}`);
    }
    console.log(rows.join("\n"));
  });
});
