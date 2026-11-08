/**
 * The Arc parity fixtures: fixed inspections over the fake chain (chain-fake.ts), with Arc's own configuration from the
 * registry (`arcInspectChain`), that cover every place the engine used to assume Arc: v4's native currency as USDC, the
 * USDC ERC-20 at 0x3600, the trade simulation's single native balance, the PREVRANDAO wording, the TokenFactory shortcut.
 * `capture` runs one and returns what arc-parity.test.ts compares with the golden file: the report, and every call the
 * engine made to the chain (the trade simulation's throwaway addresses masked, long hex shortened to a hash).
 */
import { decodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { ARCOS, EURC, UNISWAP_V4, USDC, arcInspectChain, tradeSimulatorAbi, tradeSimulatorRuntime, type Address, type DexConfig, type NetworkId } from "@arcos/chain";
import { chainInput } from "../../chain-input";
import { ExplorerUnavailable, type ExplorerSource, type Holder } from "../../explorer";
import { inspect } from "../../inspect";
import type { ChainReader, ExtraPool, InspectInput } from "../../types";
import { NATIVE, sqrtRatioAtTick, v4PoolId, v4PoolKey } from "../../v4";
import { fakeChain, readKey, v2PairReads, type FakeChain, type FakePool, type FakeSimulation } from "./chain-fake";

const TOKEN = "0x1111111111111111111111111111111111111111"; // sorts above native (0x0) and below USDC (0x36…) and EURC
const IMPL = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";
const PAIR = "0x4444444444444444444444444444444444444444";
const ADMIN = "0x5555555555555555555555555555555555555555";
const WALLET = "0x6666666666666666666666666666666666666666";
const V3_POOL = "0x7777777777777777777777777777777777777777";
const AERO_POOL = "0x8888888888888888888888888888888888888888";
const EURC_PAIR = "0x9999999999999999999999999999999999999999";
const HOOK = "0x94f8be2402C0e2eb65F3218a7282A5301371E044";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dEaD";

const PLAIN = "0x63a9059cbb00"; // PUSH4 transfer, STOP
const MINTABLE = "0x63a9059cbb6340c10f1900"; // PUSH4 transfer, PUSH4 mint(address,uint256), STOP
const RANDOM = "0x63a9059cbb4400"; // PUSH4 transfer, PREVRANDAO, STOP
const cloneOf = (target: string) => `0x363d3d373d3d3d363d73${target.slice(2)}5af43d82803e903d91602b57fd5bf3`;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const slotWith = (address: string) => `0x000000000000000000000000${address.slice(2)}`;

const USDC_UNITS = 1_000_000n;
const lower = (a: string) => a.toLowerCase();

/** Every factory question `dex` asks about `token` answered "no pool" (the zero address), as a factory answers. */
function noPools(dex: DexConfig, token: string): Record<string, unknown> {
  const quotes = dex.quoteTokens.map((q) => q.address).filter((q) => lower(q) !== lower(token));
  return Object.fromEntries(
    quotes.flatMap((q) => [
      ...(dex.v2Factory ? [[readKey(dex.v2Factory, "getPair", [token, q]), ZERO]] : []),
      ...(dex.v3Factory ? (dex.v3FeeTiers ?? []).map((fee) => [readKey(dex.v3Factory!, "getPool", [token, q, fee]), ZERO]) : []),
      ...(dex.aero ? dex.aero.tickSpacings.map((spacing) => [readKey(dex.aero!.clFactory, "getPool", [token, q, spacing]), ZERO]) : []),
    ]),
  );
}

/** A v4 pool on tick -1251, 10^12 liquidity; quoted unless told otherwise. */
const v4At = (over: Partial<FakePool> = {}): FakePool => ({ sqrtPriceX96: sqrtRatioAtTick(-1251), tick: -1251, liquidity: 10n ** 12n, quote: { amountIn: 1n }, ...over });

const ok = (spent: bigint, received: bigint, bought = 5n * 10n ** 18n): FakeSimulation => ({ result: { status: 0, spent, paidOut: bought, bought, sold: bought, received } });
const status = (s: number, over: Partial<{ spent: bigint; paidOut: bigint; bought: bigint; sold: bigint; received: bigint }> = {}): FakeSimulation => ({
  result: { status: s, spent: 10n * USDC_UNITS, paidOut: 5n * 10n ** 18n, bought: 5n * 10n ** 18n, sold: 0n, received: 0n, ...over },
});

const holders = (rows: [string, bigint][]): Holder[] => rows.map(([address, value]) => ({ address, isContract: false, name: null, value }));

/** An explorer that knows the token: verified, with the holder list given (complete). */
function explorer(over: Partial<ExplorerSource> & { rows?: [string, bigint][] } = {}): ExplorerSource {
  const { rows = [[WALLET, 100n], [OWNER, 50n]], ...rest } = over;
  return {
    contract: async () => ({ verified: true, name: "Token", abi: null, proxyType: null, implementations: [] }),
    token: async () => ({ name: "Token", symbol: "TKN", decimals: 18, totalSupply: "1000", holdersCount: rows.length }),
    topHolders: async () => ({ holders: holders(rows), complete: true }),
    tokenBalances: async () => [],
    ...rest,
  };
}

const down = (): ExplorerSource => {
  const fail = async (): Promise<never> => {
    throw new ExplorerUnavailable(403, "challenge");
  };
  return { contract: fail, token: fail, topHolders: fail, tokenBalances: fail };
};

export type Scenario = {
  name: string;
  network: NetworkId;
  token: Address;
  chain: FakeChain;
  /** Storage words by `address:slot` (lowercase address); `storageError` fails every storage read. */
  storage?: Record<string, string>;
  storageError?: Error;
  explorer: ExplorerSource | null;
  extraPools?: ExtraPool[];
};

const mainnetDex = arcInspectChain("mainnet").dex!;
const EURC_MAINNET = EURC.mainnet;

const nativeKey = v4PoolKey(TOKEN, NATIVE, 3000, 60);
const usdcKey = v4PoolKey(TOKEN, USDC, 500, 10);
const hookedKey = v4PoolKey(TOKEN, NATIVE, 3000, 60, HOOK);
const v4Pools = (...pools: [ReturnType<typeof v4PoolKey>, FakePool][]): FakeChain["v4"] => Object.fromEntries(pools.map(([key, pool]) => [v4PoolId(key), pool]));
const byPool = (sims: Record<string, FakeSimulation>) => (trade: { pool: string; usdc: string }): FakeSimulation =>
  sims[`${lower(trade.pool)}:${lower(trade.usdc)}`] ?? sims[lower(trade.pool)] ?? { returns: "0x" };

const v2Pair = (quoteReserve: bigint, tokenReserve = 10n ** 24n) => v2PairReads(PAIR, USDC, TOKEN, quoteReserve, tokenReserve);
const lp = (supply: bigint, burned: bigint) => ({
  [readKey(PAIR, "totalSupply", [])]: supply,
  [readKey(PAIR, "balanceOf", [ZERO])]: 0n,
  [readKey(PAIR, "balanceOf", [DEAD])]: burned,
});

export const SCENARIOS: Scenario[] = [
  {
    name: "a plain renounced token with no pool, mainnet",
    network: "mainnet",
    token: TOKEN,
    chain: { code: { [TOKEN]: PLAIN }, reads: { ...noPools(mainnetDex, TOKEN), [readKey(TOKEN, "owner", [])]: ZERO, [readKey(TOKEN, "totalSupply", [])]: 1000n } },
    explorer: explorer(),
  },
  {
    name: "an owned mintable token with a liquid v2 pair, unlocked LP and a round trip that passes",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: MINTABLE },
      reads: {
        ...noPools(mainnetDex, TOKEN),
        [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, USDC])]: PAIR,
        ...v2Pair(50_000n * USDC_UNITS),
        ...lp(100n, 10n),
        [readKey(TOKEN, "owner", [])]: OWNER,
        [readKey(TOKEN, "totalSupply", [])]: 1000n,
      },
      simulation: ok(10n * USDC_UNITS, 9_940_000n),
    },
    explorer: explorer({ rows: [[PAIR, 500n], [OWNER, 300n], [WALLET, 100n], [DEAD, 100n]] }),
  },
  {
    name: "a sell refused by a v3 pool and tried again in the v2 pair",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: {
        ...noPools(mainnetDex, TOKEN),
        [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, USDC])]: PAIR,
        ...v2Pair(5_000n * USDC_UNITS),
        ...lp(100n, 100n),
        [readKey(mainnetDex.v3Factory!, "getPool", [TOKEN, USDC, 3000])]: V3_POOL,
        [readKey(USDC, "balanceOf", [V3_POOL])]: 20_000n * USDC_UNITS,
        [readKey(TOKEN, "owner", [])]: DEAD,
      },
      simulation: byPool({ [lower(V3_POOL)]: status(3), [lower(PAIR)]: ok(5n * USDC_UNITS, 4_970_000n) }),
    },
    explorer: explorer(),
  },
  {
    name: "an Aerodrome USDC pool beside a deeper EURC pair the trade can't use",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: {
        ...noPools(mainnetDex, TOKEN),
        [readKey(mainnetDex.aero!.clFactory, "getPool", [TOKEN, USDC, 50])]: AERO_POOL,
        [readKey(USDC, "balanceOf", [AERO_POOL])]: 2_000n * USDC_UNITS,
        [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, EURC_MAINNET])]: EURC_PAIR,
        ...v2PairReads(EURC_PAIR, EURC_MAINNET, TOKEN, 90_000n * USDC_UNITS),
        [readKey(EURC_PAIR, "totalSupply", [])]: 0n,
        [readKey(TOKEN, "owner", [])]: ZERO,
      },
      simulation: ok(2n * USDC_UNITS, 1_990_000n),
    },
    explorer: explorer(),
  },
  {
    name: "v4 pools against native USDC (liquid) and the USDC ERC-20 (short), each traded",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: { ...noPools(mainnetDex, TOKEN), [readKey(TOKEN, "owner", [])]: ZERO },
      v4: v4Pools([nativeKey, v4At()], [usdcKey, v4At({ quote: undefined })]),
      simulation: byPool({
        [`${lower(UNISWAP_V4.poolManager)}:${lower(NATIVE)}`]: ok(10n ** 16n, 99n * 10n ** 14n),
        [`${lower(UNISWAP_V4.poolManager)}:${lower(USDC)}`]: ok(10_000n, 9_900n),
      }),
    },
    explorer: explorer({ rows: [[UNISWAP_V4.poolManager, 400n], [WALLET, 300n], [OWNER, 300n]] }),
  },
  {
    name: "a hooked native-USDC v4 pool the index lists, the only pool",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: { ...noPools(mainnetDex, TOKEN), [readKey(TOKEN, "owner", [])]: ZERO },
      v4: v4Pools([hookedKey, v4At({ quote: undefined })]),
      simulation: ok(10n ** 16n, 98n * 10n ** 14n),
    },
    explorer: explorer(),
    extraPools: [{ version: "v4", key: hookedKey }],
  },
  {
    name: "USDC itself on mainnet: neither form of USDC is a quote",
    network: "mainnet",
    token: USDC,
    chain: { code: { [USDC]: PLAIN }, reads: { ...noPools(mainnetDex, USDC) } },
    explorer: explorer(),
  },
  {
    name: "USDC itself on testnet",
    network: "testnet",
    token: USDC,
    chain: { code: { [USDC]: PLAIN } },
    explorer: explorer(),
  },
  {
    name: "EURC on testnet with a native-USDC v4 pool",
    network: "testnet",
    token: EURC.testnet,
    chain: {
      code: { [EURC.testnet]: PLAIN },
      v4: v4Pools([v4PoolKey(EURC.testnet, NATIVE, 500, 10), v4At()]),
      simulation: ok(10n ** 16n, 99n * 10n ** 14n),
    },
    explorer: explorer(),
  },
  {
    name: "a token that uses PREVRANDAO, testnet",
    network: "testnet",
    token: TOKEN,
    chain: { code: { [TOKEN]: RANDOM }, reads: { [readKey(TOKEN, "owner", [])]: ZERO } },
    explorer: explorer(),
  },
  {
    name: "an EIP-1967 proxy with an admin, renounced",
    network: "mainnet",
    token: TOKEN,
    chain: { code: { [TOKEN]: PLAIN, [IMPL]: MINTABLE }, reads: { ...noPools(mainnetDex, TOKEN), [readKey(TOKEN, "owner", [])]: ZERO } },
    storage: { [`${TOKEN}:${IMPL_SLOT}`]: slotWith(IMPL), [`${TOKEN}:${ADMIN_SLOT}`]: slotWith(ADMIN) },
    explorer: explorer(),
  },
  {
    name: "a clone of code that uses PREVRANDAO, testnet",
    network: "testnet",
    token: TOKEN,
    chain: { code: { [TOKEN]: cloneOf(IMPL), [IMPL]: RANDOM }, reads: { [readKey(TOKEN, "owner", [])]: OWNER } },
    explorer: explorer(),
  },
  {
    name: "a token the ArcOS TokenFactory made, unverified on the explorer, testnet",
    network: "testnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: { [readKey(ARCOS.testnet!.tokenFactory, "isArcosToken", [TOKEN])]: true, [readKey(TOKEN, "owner", [])]: ZERO },
    },
    explorer: explorer({ contract: async () => ({ verified: false, name: null, abi: null, proxyType: null, implementations: [] }) }),
  },
  {
    name: "the explorer down and the RPC failing on some reads",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: { [readKey(TOKEN, "owner", [])]: new Error("ETIMEDOUT"), [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, USDC])]: new Error("ETIMEDOUT") },
    },
    storageError: new Error("fetch failed"),
    explorer: down(),
  },
  {
    name: "a buy the pool paid out for and no tokens arrived",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: { ...noPools(mainnetDex, TOKEN), [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, USDC])]: PAIR, ...v2Pair(50_000n * USDC_UNITS), ...lp(100n, 100n) },
      simulation: status(0, { paidOut: 5n * 10n ** 18n, bought: 0n }),
    },
    explorer: explorer(),
  },
  {
    name: "a node that ignores the state override",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: { ...noPools(mainnetDex, TOKEN), [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, USDC])]: PAIR, ...v2Pair(50_000n * USDC_UNITS), ...lp(100n, 100n) },
    },
    explorer: explorer(),
  },
  {
    name: "a gas price that can't be read",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: { ...noPools(mainnetDex, TOKEN), [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, USDC])]: PAIR, ...v2Pair(50_000n * USDC_UNITS), ...lp(100n, 100n) },
      simulation: ok(10n * USDC_UNITS, 9_940_000n),
      gasPrice: new Error("ETIMEDOUT"),
    },
    explorer: explorer(),
  },
  {
    name: "a sell that reverts in a v2 pair, LP burned",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: { ...noPools(mainnetDex, TOKEN), [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, USDC])]: PAIR, ...v2Pair(50_000n * USDC_UNITS), ...lp(100n, 100n) },
      simulation: status(3),
      gasPrice: 160_000_000_000n,
    },
    explorer: explorer(),
  },
  {
    name: "only an EURC pair: no USDC pool to trade against",
    network: "mainnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      reads: {
        ...noPools(mainnetDex, TOKEN),
        [readKey(mainnetDex.v2Factory!, "getPair", [TOKEN, EURC_MAINNET])]: EURC_PAIR,
        ...v2PairReads(EURC_PAIR, EURC_MAINNET, TOKEN, 90_000n * USDC_UNITS),
        [readKey(EURC_PAIR, "totalSupply", [])]: 100n,
        [readKey(EURC_PAIR, "balanceOf", [ZERO])]: 0n,
        [readKey(EURC_PAIR, "balanceOf", [DEAD])]: 0n,
      },
      simulation: ok(10n * USDC_UNITS, 9_940_000n),
    },
    explorer: explorer(),
  },
  {
    name: "holders concentrated in one wallet, the PoolManager left out",
    network: "mainnet",
    token: TOKEN,
    chain: { code: { [TOKEN]: PLAIN }, reads: { ...noPools(mainnetDex, TOKEN), [readKey(TOKEN, "totalSupply", [])]: 1000n } },
    explorer: explorer({ rows: [[UNISWAP_V4.poolManager, 300n], [DEAD, 100n], [OWNER, 600n]] }),
  },
  {
    name: "a v4 quote that fails at the transport level, testnet",
    network: "testnet",
    token: TOKEN,
    chain: {
      code: { [TOKEN]: PLAIN },
      v4: v4Pools([v4PoolKey(TOKEN, USDC, 500, 10), v4At({ quote: { fails: new Error("ETIMEDOUT") } })]),
      simulation: { fails: new Error("ETIMEDOUT") },
    },
    explorer: explorer(),
  },
  {
    name: "v4 and Aerodrome silent while v2 and v3 answer",
    network: "mainnet",
    token: TOKEN,
    chain: { code: { [TOKEN]: PLAIN }, reads: { ...noPools(mainnetDex, TOKEN) }, multicallReverts: true },
    explorer: explorer(),
  },
  {
    name: "testnet's v4 alone, nothing found",
    network: "testnet",
    token: TOKEN,
    chain: { code: { [TOKEN]: PLAIN }, reads: { [readKey(TOKEN, "getOwner", [])]: OWNER } },
    explorer: null,
  },
];

const show = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === "bigint") return `${x}n`;
    if (typeof x === "string" && /^0x[0-9a-fA-F]{67,}$/.test(x)) return x === tradeSimulatorRuntime ? "<simulator>" : `<${keccak256(x as Hex).slice(0, 18)}>`;
    return x;
  });

/** A multicall's inner calls as their count, their targets and a hash of the whole list; any other call's arguments as they are. */
function argsOf(fn: string, args: readonly unknown[]): string {
  if (fn !== "aggregate3") return show(args);
  const calls = args[0] as { target: string }[];
  const text = show(args);
  return `${calls.length} calls to ${[...new Set(calls.map((c) => c.target))].join(",")} ${keccak256(toHex(text)).slice(0, 18)}`;
}

/** Every call made to `inner`, one line each, in a form the same calls always give. */
function recorded(inner: ChainReader, log: string[]): ChainReader {
  const note = <T>(line: string, call: () => Promise<T>): Promise<T> => {
    log.push(line);
    return call();
  };
  return {
    getCode: (a) => note(`getCode ${a}`, () => inner.getCode(a)),
    getStorageAt: (a, slot, block) => note(`getStorageAt ${a} ${slot} ${show(block)}`, () => inner.getStorageAt(a, slot, block)),
    read: (a, abi, fn, args, options) => note(`read ${a} ${fn} ${argsOf(fn, args ?? [])} ${show(options ?? {})}`, () => inner.read(a, abi, fn, args, options)),
    blockNumber: () => note("blockNumber", () => inner.blockNumber()),
    gasPrice: () => note("gasPrice", () => inner.gasPrice()),
    callWithOverride: (call, overrides) => {
      const { args } = decodeFunctionData({ abi: tradeSimulatorAbi, data: call.data });
      const trade = args[0] as { router: string } & Record<string, unknown>;
      const as = (a: string) => (a === call.from ? "<S>" : a === trade.router ? "<R>" : a);
      const line = show({
        from: as(call.from), to: as(call.to), gas: call.gas, gasPrice: call.gasPrice,
        trade: { ...trade, router: as(trade.router) },
        overrides: overrides.map((o) => ({ ...o, address: as(o.address) })),
      });
      return note(`callWithOverride ${line}`, () => inner.callWithOverride(call, overrides));
    },
  };
}

/** The input the site builds for Arc on `network` (inspect-input.ts), around the scenario's reader and explorer. */
export function inputOf(s: Scenario, reader: ChainReader): InspectInput {
  return {
    ...chainInput(arcInspectChain(s.network)),
    address: s.token,
    network: s.network,
    reader,
    explorer: s.explorer,
    ...(s.extraPools ? { extraPools: s.extraPools } : {}),
    now: () => new Date("2026-11-08T00:00:00Z"),
  };
}

export type Capture = { report: Record<string, unknown>; calls: string[] };

/** Runs one scenario and returns its report (as JSON) and the calls it made, sorted. */
export async function capture(s: Scenario): Promise<Capture> {
  // The fake keys code by lowercase address.
  const fake = fakeChain({ ...s.chain, code: Object.fromEntries(Object.entries(s.chain.code ?? {}).map(([a, c]) => [lower(a), c])) });
  const reader: ChainReader = {
    ...fake,
    getStorageAt: async (a, slot) => {
      if (s.storageError) throw s.storageError;
      return (s.storage?.[`${lower(a)}:${slot}`] as Hex | undefined) ?? null;
    },
  };
  const calls: string[] = [];
  const report = await inspect(inputOf(s, recorded(reader, calls)));
  return { report: JSON.parse(show(report)) as Record<string, unknown>, calls: calls.sort() };
}
