import { decodeFunctionData, encodeFunctionResult, multicall3Abi, type Abi, type Hex } from "viem";
import type { Address } from "@arcos/chain";
import { erc20Abi, stateViewAbi, type ChainReader } from "@arcos/inspector";
import { ownableAbi, v2PairAbi } from "../watch-read";

// A chain for the watch reader's tests: answers aggregate3 call by call, as Multicall3 does, and the two slot reads.

/** The call reverted (Multicall3 reports `success: false`). */
export const REVERT = Symbol("revert");
/** Raw return data in place of a decodable value: what a bytes32 symbol answers. */
export type Raw = { raw: Hex };

export type Call = { target: Address; functionName: string; args: readonly unknown[] };
export type CallAnswer = (call: Call) => unknown | typeof REVERT | Raw;
export type SlotAnswer = (address: Address, slot: Hex) => Hex | null;

/** Every ABI the reader's aggregate uses, for decoding what it asked. */
const watchAbi: Abi = [...ownableAbi, ...erc20Abi, ...v2PairAbi, ...stateViewAbi];

export type Sent = { kind: "aggregate"; blockNumber: bigint | undefined; calls: Call[] } | { kind: "slot"; address: Address; slot: Hex; blockNumber: bigint | undefined };

export type FakeWatchReaderOptions = {
  /** Answers each call inside the aggregate. */
  answer: CallAnswer;
  /** Answers the slot reads; by default every slot is empty. */
  slots?: SlotAnswer;
  /** The aggregate itself rejects with this (a transport failure, or CallReverted), or hangs when `"hang"`. */
  aggregate?: Error | "hang";
  /** The slot reads reject with this, or hang. */
  slotRead?: Error | "hang";
};

const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && "raw" in v;
const never = new Promise<never>(() => {});

export function fakeWatchReader(options: FakeWatchReaderOptions): ChainReader & { sent: Sent[] } {
  const sent: Sent[] = [];
  const slots = options.slots ?? (() => null);
  return {
    sent,
    getCode: async () => null,
    blockNumber: async () => 0n,
    gasPrice: async () => 0n,
    callWithOverride: async () => {
      throw new Error("the watch reader never simulates");
    },
    getStorageAt: (address, slot, blockNumber) => {
      sent.push({ kind: "slot", address, slot, blockNumber });
      if (options.slotRead === "hang") return never;
      if (options.slotRead) return Promise.reject(options.slotRead);
      return Promise.resolve(slots(address, slot));
    },
    read: (address, abi, functionName, args = [], readOptions) => {
      if (abi !== multicall3Abi || functionName !== "aggregate3") return Promise.reject(new Error(`unexpected read ${functionName}`));
      const asked = (args[0] as { target: Address; allowFailure: boolean; callData: Hex }[]).map((c) => {
        const decoded = decodeFunctionData({ abi: watchAbi, data: c.callData });
        return { target: c.target, functionName: decoded.functionName, args: decoded.args ?? [], allowFailure: c.allowFailure };
      });
      sent.push({ kind: "aggregate", blockNumber: readOptions?.blockNumber, calls: asked.map(({ target, functionName, args }) => ({ target, functionName, args })) });
      if (options.aggregate === "hang") return never;
      if (options.aggregate) return Promise.reject(options.aggregate);
      if (!asked.every((c) => c.allowFailure)) return Promise.reject(new Error("every call must allow failure"));
      return Promise.resolve(
        asked.map((c) => {
          const value = options.answer({ target: c.target, functionName: c.functionName, args: c.args });
          if (value === REVERT) return { success: false, returnData: "0x" as Hex };
          if (isRaw(value)) return { success: true, returnData: value.raw };
          return { success: true, returnData: encodeFunctionResult({ abi: watchAbi, functionName: c.functionName, result: value } as Parameters<typeof encodeFunctionResult>[0]) };
        }),
      );
    },
  };
}

/** A 32-byte slot word holding `address`. */
export const slotWord = (address: Address): Hex => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
export const EMPTY_SLOT: Hex = `0x${"0".repeat(64)}`;
