import { decodeAbiParameters, erc20Abi, getAddress, multicall3Abi, type Address, type Hex } from "viem";
import { MULTICALL3 } from "@arcos/chain";
import { cleanLabel } from "@arcos/inspector";
import { currencySymbols } from "@/lib/positions";
import { ok, readEach, type Read } from "@/lib/reads";
import { V2_PAIR_CALLS, isV2PairShape, type RawAnswer } from "./fees";

/**
 * What the New lock form shows for a token address, read on chain: never what a dropped file claimed. Pure, with the
 * reads handed in (NewLock.tsx wires them to the RPC client).
 */
export type TokenInfo = {
  address: Address;
  symbol: string;
  name: string | null;
  decimals: number;
  /** The wallet's balance, null when it couldn't be read. */
  balance: bigint | null;
  /** What the wallet has already approved the factory for. */
  allowance: bigint | null;
  /** Shaped like a Uniswap v2 pair, as VaultFactory._isV2Pair tells (fees.ts): the LP share applies. */
  pair: { token0: Address; token1: Address; symbol0: string; symbol1: string } | null;
};

export type RawCall = { target: Address; callData: Hex };
/** Multicall3's aggregate3, each call allowed to fail: the raw return data, as `_isV2Pair` measures it. */
export type RawCalls = (calls: readonly RawCall[]) => Promise<readonly { success: boolean; returnData: Hex }[]>;

export type TokenInfoDeps = {
  read: Read;
  rawCalls: RawCalls;
  getCode: (address: Address) => Promise<Hex | undefined>;
  owner: Address;
  factory: Address;
};

export const NOT_A_TOKEN = "That address isn't a token contract.";
export const NO_DECIMALS = "This contract doesn't answer like a token: it has no decimals.";

/** aggregate3 through Multicall3 on a client that can read a contract (viem's public client). */
export function aggregate3(readContract: (args: object) => Promise<unknown>): RawCalls {
  return async (calls) =>
    (await readContract({
      address: MULTICALL3,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
    })) as readonly { success: boolean; returnData: Hex }[];
}

const word = (answer: RawAnswer): Address | null => {
  if (!answer || answer.length !== 66) return null;
  try {
    return getAddress(decodeAbiParameters([{ type: "address" }], answer)[0]);
  } catch {
    return null;
  }
};

/** The token's details, or the sentence that says why it can't be locked as one. Throws when the RPC can't answer. */
export async function readTokenInfo(token: Address, deps: TokenInfoDeps): Promise<TokenInfo | { error: string }> {
  const code = await deps.getCode(token);
  if (!code || code === "0x") return { error: NOT_A_TOKEN };
  const [symbol, name, decimals, balance, allowance] = await readEach(deps.read, [
    { address: token, abi: erc20Abi, functionName: "symbol" },
    { address: token, abi: erc20Abi, functionName: "name" },
    { address: token, abi: erc20Abi, functionName: "decimals" },
    { address: token, abi: erc20Abi, functionName: "balanceOf", args: [deps.owner] },
    { address: token, abi: erc20Abi, functionName: "allowance", args: [deps.owner, deps.factory] },
  ]);
  const places = ok(decimals);
  if (typeof places !== "number" || !Number.isInteger(places) || places < 0 || places > 255) return { error: NO_DECIMALS };
  const raw = await deps.rawCalls([
    { target: token, callData: V2_PAIR_CALLS.token0 },
    { target: token, callData: V2_PAIR_CALLS.token1 },
    { target: token, callData: V2_PAIR_CALLS.getReserves },
  ]);
  const answer = (i: number): RawAnswer => (raw[i]?.success ? raw[i]!.returnData : null);
  let pair: TokenInfo["pair"] = null;
  if (isV2PairShape(answer(0), answer(1), answer(2))) {
    const [token0, token1] = [word(answer(0)), word(answer(1))];
    if (token0 && token1) {
      const symbols = await currencySymbols(deps.read, [token0, token1]);
      pair = { token0, token1, symbol0: symbols.get(token0.toLowerCase()) ?? "?", symbol1: symbols.get(token1.toLowerCase()) ?? "?" };
    } else {
      pair = { token0: token, token1: token, symbol0: "?", symbol1: "?" };
    }
  }
  const text = ok(symbol);
  const label = ok(name);
  const held = ok(balance);
  const approved = ok(allowance);
  return {
    address: token,
    symbol: cleanLabel(typeof text === "string" ? text : null, 32) ?? "?",
    name: cleanLabel(typeof label === "string" ? label : null, 64),
    decimals: places,
    balance: typeof held === "bigint" ? held : null,
    allowance: typeof approved === "bigint" ? approved : null,
    pair,
  };
}
