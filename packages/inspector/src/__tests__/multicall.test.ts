import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbi } from "viem";
import { MULTICALL3 } from "@arcos/chain";
import { multicall, type BatchCall } from "../multicall";
import { CallReverted, type ChainReader } from "../types";

const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"]);
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
type Answer = { success: boolean; returnData: `0x${string}` };
type Sent = { address: string; abi: unknown; fn: string; calls: readonly { target: string; allowFailure: boolean; callData: `0x${string}` }[] };

/** A reader that answers `aggregate3` the way Multicall3 does, from `answer`: one entry per call, in order. */
function aggregator(answer: Answer[] | Error) {
  const sent: Sent[] = [];
  const reader: ChainReader = {
    getCode: async () => null,
    getStorageAt: async () => null,
    blockNumber: async () => 1n,
    gasPrice: async () => 1n,
    callWithOverride: async () => {
      throw new Error("multicall never simulates");
    },
    read: async (address, readAbi, fn, args = []) => {
      sent.push({ address, abi: readAbi, fn, calls: args[0] as Sent["calls"] });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { reader, sent };
}

const ok = (functionName: "balanceOf" | "symbol", result: bigint | string): Answer => ({
  success: true,
  returnData: encodeFunctionResult({ abi, functionName, result } as never),
});

describe("multicall", () => {
  it("asks Multicall3 once, lets each call fail on its own, and decodes each answer with its own ABI", async () => {
    const { reader, sent } = aggregator([ok("balanceOf", 5n), ok("symbol", "USDC")]);
    const out = await multicall(reader, [
      { target: A, abi, functionName: "balanceOf", args: [B] },
      { target: B, abi, functionName: "symbol" },
    ]);
    expect(out).toEqual([{ ok: true, value: 5n }, { ok: true, value: "USDC" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ address: MULTICALL3, abi: multicall3Abi, fn: "aggregate3" });
    expect(sent[0]!.calls.map((c) => [c.target, c.allowFailure])).toEqual([[A, true], [B, true]]);
    expect(decodeFunctionData({ abi, data: sent[0]!.calls[0]!.callData })).toMatchObject({ functionName: "balanceOf", args: [B] });
    expect(decodeFunctionData({ abi, data: sent[0]!.calls[1]!.callData })).toMatchObject({ functionName: "symbol" });
  });

  it("reports a call that reverted as not ok, without failing the others", async () => {
    const { reader } = aggregator([{ success: false, returnData: "0x08c379a0" }, ok("symbol", "EURC")]);
    const out = await multicall(reader, [
      { target: A, abi, functionName: "balanceOf", args: [B] },
      { target: B, abi, functionName: "symbol" },
    ]);
    expect(out).toEqual([{ ok: false }, { ok: true, value: "EURC" }]);
  });

  it("reads an answer its ABI can't decode as not ok: an address with no code answers 0x, which Multicall3 calls a success", async () => {
    const { reader } = aggregator([{ success: true, returnData: "0x" }]);
    expect(await multicall(reader, [{ target: A, abi, functionName: "balanceOf", args: [B] }])).toEqual([{ ok: false }]);
  });

  it("asks nothing for an empty batch", async () => {
    const { reader, sent } = aggregator([]);
    expect(await multicall(reader, [])).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("rejects, as the read did, when the aggregate itself fails", async () => {
    const call: BatchCall = { target: A, abi, functionName: "symbol" };
    await expect(multicall(aggregator(new CallReverted()).reader, [call])).rejects.toBeInstanceOf(CallReverted);
    await expect(multicall(aggregator(new Error("ETIMEDOUT")).reader, [call])).rejects.toThrow("ETIMEDOUT");
  });

  it("refuses an answer with the wrong number of results", async () => {
    const { reader } = aggregator([ok("symbol", "USDC")]);
    await expect(
      multicall(reader, [
        { target: A, abi, functionName: "symbol" },
        { target: B, abi, functionName: "symbol" },
      ]),
    ).rejects.toThrow(/1 of 2/);
  });
});
