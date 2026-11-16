import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Address, type Hex } from "viem";
import type { ContractRead, Read, ReadResult } from "@/lib/reads";
import { V2_PAIR_CALLS } from "../fees";
import { NOT_A_TOKEN, NO_DECIMALS, readTokenInfo, type RawCall, type RawCalls } from "../tokenInfo";

const OWNER: Address = "0x7e57000000000000000000000000000000000001";
const FACTORY: Address = "0x2aA12f98795E7A65072950AfbA9d1E023D398241";
const TOKEN: Address = "0xBFF22091be481B41C8CA49862653aBA216bAc041";
const PAIR: Address = "0xAdb5189625C0B1F634113A04B2d3D1635Dc429bc";
const T0: Address = "0xBFF22091be481B41C8CA49862653aBA216bAc041";
const T1: Address = "0xF4F40da2D2b7F0a2C5d2d3E113dDfBEB3FfDCa5E";

const word = (a: Address) => encodeAbiParameters([{ type: "address" }], [a]);
const reserves = encodeAbiParameters([{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }], [1n, 2n, 3]);

function reads(answers: Record<string, unknown>): Read {
  return async (calls: readonly ContractRead[]) =>
    calls.map((c): ReadResult => {
      const key = `${c.address}.${c.functionName}`.toLowerCase();
      return key in answers ? { status: "success", result: answers[key] } : { status: "failure", error: new Error(key) };
    });
}
const raw = (answers: Record<string, Hex | null>): RawCalls => async (calls: readonly RawCall[]) =>
  calls.map((c) => {
    const data = answers[`${c.target}.${c.callData}`.toLowerCase()];
    return data === undefined || data === null ? { success: false, returnData: "0x" as Hex } : { success: true, returnData: data };
  });
const k = (a: string, f: string) => `${a}.${f}`.toLowerCase();

describe("readTokenInfo", () => {
  const erc20 = { [k(TOKEN, "symbol")]: "VTB\u202e", [k(TOKEN, "name")]: "Vault Test Beta", [k(TOKEN, "decimals")]: 18, [k(TOKEN, "balanceOf")]: 5n, [k(TOKEN, "allowance")]: 0n };

  it("reads a plain token: cleaned symbol, decimals, balance, allowance, and no pair", async () => {
    const info = await readTokenInfo(TOKEN, { read: reads(erc20), rawCalls: raw({}), getCode: async () => "0x60", owner: OWNER, factory: FACTORY });
    expect(info).toEqual({ address: TOKEN, symbol: "VTB", name: "Vault Test Beta", decimals: 18, balance: 5n, allowance: 0n, pair: null });
  });

  it("refuses an address with no code, and a contract with no decimals", async () => {
    expect(await readTokenInfo(TOKEN, { read: reads(erc20), rawCalls: raw({}), getCode: async () => undefined, owner: OWNER, factory: FACTORY })).toEqual({ error: NOT_A_TOKEN });
    const noDecimals = { ...erc20, [k(TOKEN, "decimals")]: undefined };
    delete noDecimals[k(TOKEN, "decimals")];
    expect(await readTokenInfo(TOKEN, { read: reads(noDecimals), rawCalls: raw({}), getCode: async () => "0x60", owner: OWNER, factory: FACTORY })).toEqual({ error: NO_DECIMALS });
  });

  it("names a Uniswap v2 pair's two tokens when its shape is the one the factory charges the LP share on", async () => {
    const lp = {
      [k(PAIR, "symbol")]: "UNI-V2",
      [k(PAIR, "name")]: "Uniswap V2",
      [k(PAIR, "decimals")]: 18,
      [k(PAIR, "balanceOf")]: 10n,
      [k(PAIR, "allowance")]: 0n,
      [k(T0, "symbol")]: "VTB",
      [k(T1, "symbol")]: "VTA",
    };
    const shape = {
      [k(PAIR, V2_PAIR_CALLS.token0)]: word(T0),
      [k(PAIR, V2_PAIR_CALLS.token1)]: word(T1),
      [k(PAIR, V2_PAIR_CALLS.getReserves)]: reserves,
    };
    const info = await readTokenInfo(PAIR, { read: reads(lp), rawCalls: raw(shape), getCode: async () => "0x60", owner: OWNER, factory: FACTORY });
    expect(info).toMatchObject({ symbol: "UNI-V2", pair: { token0: T0, token1: T1, symbol0: "VTB", symbol1: "VTA" } });
    const wrongReserves = { ...shape, [k(PAIR, V2_PAIR_CALLS.getReserves)]: word(T0) };
    expect(await readTokenInfo(PAIR, { read: reads(lp), rawCalls: raw(wrongReserves), getCode: async () => "0x60", owner: OWNER, factory: FACTORY })).toMatchObject({ pair: null });
  });
});
