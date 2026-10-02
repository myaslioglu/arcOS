import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, type Hex } from "viem";
import { MULTICALL3, UNISWAP_V4 } from "@arcos/chain";
import { CallReverted, type ChainReader, type OverrideCall, type StateOverride } from "../../types";

// The fake answers with its own copies of the ABIs, written out separately from the ones the engine uses: a wrong function
// signature in the engine then fails a test instead of agreeing with itself.
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
]);
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)",
]);
const simulatorAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Trade { uint8 kind; address pool; address token; address usdc; uint256 amount; PoolKey key; }",
  "struct Result { uint8 status; uint256 spent; uint256 bought; uint256 sold; uint256 received; }",
  "function simulate(Trade t) returns (Result r)",
]);
const plainAbi = parseAbi([
  "function getPool(address,address,int24) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);

/** A v4 pool as the fake chain holds it. */
export type FakePool = {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /**
   * What the quoter does for this pool: `{ amountIn }` answers; `{ reverts }` reverts with those bytes (see fixtures/quoter-reverts.ts);
   * `{ fails }` is a transport failure. Absent: it reverts with "not enough liquidity" for this pool, as for a pool that can't pay.
   */
  quote?: { amountIn: bigint } | { reverts: `0x${string}` } | { fails: Error };
};

/**
 * A fake chain for the pool tests. Plain reads are keyed like the ones in inspect.test.ts: `"<address>.<fn>(<args>)"`, all
 * lowercase, args joined by commas. A value that is an `Error` is thrown, and a key that isn't there reverts, which is what a
 * contract answering "no" looks like to the engine. Multicall3's `aggregate3` is answered too: each inner call goes to the v4
 * state below or to the plain reads.
 */
export type FakeChain = {
  code?: Record<string, string>;
  reads?: Record<string, unknown>;
  /** Uniswap v4 pools by pool id, lowercase. One that isn't listed was never initialised: StateView answers zeros for it. */
  v4?: Record<string, FakePool>;
  /** Targets (lowercase) that answer `0x` inside a multicall, as an address with no code does. */
  silent?: string[];
  /** StateView's getLiquidity fails inside the multicall, for every pool. */
  liquidityFails?: boolean;
  /** Multicall3 itself reverts. */
  multicallReverts?: boolean;
  /** Multicall3's request fails at the transport level. */
  multicallError?: Error;
  /** The trade simulation's answer. Absent: `0x`, as from a node that ignored the override. */
  simulation?: FakeSimulation;
};

/** What the simulator returns, as the fake's own ABI copy decodes it. */
export type SimResult = { status: number; spent: bigint; bought: bigint; sold: bigint; received: bigint };
/**
 * What the trade simulation's eth_call does: return a result; `{ reverts }` (the call itself reverted, or ran out of its gas:
 * both reach the engine as a CallReverted); `{ fails }` rejects with that error as it is (a transport failure, or a node's
 * refusal); `{ returns }` answers those raw bytes (`0x` is a node that ignored the override and ran no code).
 */
export type FakeSimulation = { result: SimResult } | { reverts: true } | { fails: Error } | { returns: Hex };
/** One trade simulation the fake received, its calldata decoded with the fake's own ABI copy. */
export type SimRecord = {
  call: OverrideCall;
  overrides: readonly StateOverride[];
  trade: { kind: number; pool: string; token: string; usdc: string; amount: bigint; key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string } };
};

/** What a fake reader was asked, in order (an `aggregate3` counts as one read). */
export type ReadRecord = { address: string; fn: string; args: readonly unknown[] };
/** One `aggregate3`, with each inner call decoded. */
export type BatchRecord = { calls: { target: string; fn: string; args: readonly unknown[] }[] };
/** One quote request the fake's V4Quoter received. */
export type QuoteRecord = { poolId: string; zeroForOne: boolean; exactAmount: bigint; gas: bigint | undefined };
export type FakeReader = ChainReader & { asked: ReadRecord[]; batches: BatchRecord[]; quotes: QuoteRecord[]; simulations: SimRecord[] };

const lower = (a: string) => a.toLowerCase();
/** UnexpectedRevertBytes(NotEnoughLiquidity(poolId)), laid out like the bytes read live (fixtures/quoter-reverts.ts). */
const notEnoughLiquidity = (poolId: string): string =>
  `0x6190b2b0${"20".padStart(64, "0")}${"24".padStart(64, "0")}7a5ed734${poolId.slice(2)}${"0".repeat(56)}`;
export const readKey = (address: string, fn: string, args: readonly unknown[]): string =>
  `${lower(address)}.${fn}(${args.map((x) => lower(String(x))).join(",")})`;

const poolIdOf = (k: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): string =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0 as `0x${string}`, k.currency1 as `0x${string}`, k.fee, k.tickSpacing, k.hooks as `0x${string}`],
    ),
  );

type Inner = { success: boolean; returnData: `0x${string}` };

export function fakeChain(f: FakeChain = {}): FakeReader {
  const asked: ReadRecord[] = [];
  const batches: BatchRecord[] = [];
  const quotes: QuoteRecord[] = [];
  const simulations: SimRecord[] = [];
  const silent = new Set((f.silent ?? []).map(lower));
  const stateView = lower(UNISWAP_V4.stateView);
  const quoter = lower(UNISWAP_V4.quoter);

  const plain = (address: string, fn: string, args: readonly unknown[]): unknown => {
    const key = readKey(address, fn, args);
    if (!f.reads || !(key in f.reads)) throw new CallReverted();
    const value = f.reads[key];
    if (value instanceof Error) throw value;
    return value;
  };

  const decode = (target: string, data: `0x${string}`) => {
    const abi = lower(target) === stateView ? stateViewAbi : lower(target) === quoter ? quoterAbi : plainAbi;
    const { functionName, args } = decodeFunctionData({ abi, data } as never) as { functionName: string; args: readonly unknown[] };
    return { functionName, args: args ?? [] };
  };

  const answer = (target: string, data: `0x${string}`): Inner => {
    if (silent.has(lower(target))) return { success: true, returnData: "0x" };
    const { functionName, args } = decode(target, data);
    if (lower(target) === stateView) {
      if (functionName === "getLiquidity" && f.liquidityFails) return { success: false, returnData: "0x" };
      const pool = f.v4?.[lower(String(args[0]))];
      return {
        success: true,
        returnData:
          functionName === "getSlot0"
            ? encodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", result: [pool?.sqrtPriceX96 ?? 0n, pool?.tick ?? 0, 0, pool ? 500 : 0] })
            : encodeFunctionResult({ abi: stateViewAbi, functionName: "getLiquidity", result: pool?.liquidity ?? 0n }),
      };
    }
    // A quote runs the pool's hooks and can burn a lot of gas, so it is never sent inside a multicall.
    if (lower(target) === quoter) throw new Error("a quote must be its own eth_call, not part of a multicall");
    try {
      return { success: true, returnData: encodeFunctionResult({ abi: plainAbi, functionName, result: plain(target, functionName, args) } as never) };
    } catch (e) {
      if (e instanceof CallReverted) return { success: false, returnData: "0x" };
      throw e;
    }
  };

  return {
    asked,
    batches,
    quotes,
    simulations,
    getCode: async (a) => (f.code?.[lower(a)] as `0x${string}` | undefined) ?? null,
    getStorageAt: async () => null,
    read: async (address, _abi, fn, args = [], options) => {
      asked.push({ address, fn, args });
      if (lower(address) === quoter && fn === "quoteExactOutputSingle") {
        const p = args[0] as { poolKey: Parameters<typeof poolIdOf>[0]; zeroForOne: boolean; exactAmount: bigint };
        const poolId = poolIdOf(p.poolKey);
        quotes.push({ poolId, zeroForOne: p.zeroForOne, exactAmount: p.exactAmount, gas: options?.gas });
        const quote = f.v4?.[poolId]?.quote;
        if (quote && "amountIn" in quote) return [quote.amountIn, 30_000n];
        if (quote && "fails" in quote) throw quote.fails;
        throw new CallReverted("execution reverted", quote && "reverts" in quote ? quote.reverts : (notEnoughLiquidity(poolId) as `0x${string}`));
      }
      if (lower(address) === lower(MULTICALL3) && fn === "aggregate3") {
        if (f.multicallError) throw f.multicallError;
        if (f.multicallReverts) throw new CallReverted();
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[];
        batches.push({
          calls: calls.map((c) => {
            const { functionName, args: callArgs } = decode(c.target, c.callData);
            return { target: c.target, fn: functionName, args: callArgs };
          }),
        });
        return calls.map((c) => answer(c.target, c.callData));
      }
      return plain(address, fn, args);
    },
    blockNumber: async () => 123n,
    callWithOverride: async (call, overrides) => {
      const { args } = decodeFunctionData({ abi: simulatorAbi, data: call.data });
      simulations.push({ call, overrides, trade: args[0] as SimRecord["trade"] });
      const sim = f.simulation ?? { returns: "0x" };
      if ("reverts" in sim) throw new CallReverted();
      if ("fails" in sim) throw sim.fails;
      if ("returns" in sim) return sim.returns;
      return encodeFunctionResult({ abi: simulatorAbi, functionName: "simulate", result: sim.result });
    },
  };
}
