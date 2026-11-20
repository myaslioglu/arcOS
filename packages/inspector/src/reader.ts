import { BaseError, ContractFunctionZeroDataError, type Abi, type PublicClient } from "viem";
import type { OutOfGasShape } from "@arcos/chain";
import type { Hex } from "./bytecode";
import { isOutOfGas, isRevert, revertPayload } from "./rpc-errors";
import { CallReverted, type ChainReader } from "./types";

/**
 * viem wraps a failed call deep in a `cause` chain (typically inside a `ContractFunctionExecutionError`). Two shapes
 * mean the call reached the contract and got its answer: it reverted, by the node's own account (see `isRevert`), or
 * it returned no data at all. Everything else (a timeout, an HTTP error, any JSON-RPC error that isn't a revert, a
 * gateway's -32603 included) is rethrown unchanged, because it means nothing about the contract.
 */
function mapReadError(e: unknown): never {
  if ((e instanceof BaseError && e.walk((err) => err instanceof ContractFunctionZeroDataError)) || isRevert(e)) {
    throw new CallReverted(e instanceof BaseError ? e.shortMessage : undefined, revertPayload(e));
  }
  throw e;
}

/**
 * A read that set its own gas limit and ran out of it got the node's answer: the call reverted, with nothing to say why. How
 * a node says so is the chain's (`shapes`).
 */
const mapCappedReadError =
  (shapes: readonly OutOfGasShape[]) =>
  (e: unknown): never => {
    if (isOutOfGas(e, shapes)) throw new CallReverted("out of gas", null);
    return mapReadError(e);
  };

/**
 * The engine's reader over a viem client for `chain`: `chain.outOfGas` is how that chain's nodes say a call ran out of the gas
 * it set (`InspectChain.outOfGas`). There is no default, so a reader can't silently take another chain's answers for its own.
 */
export function viemReader(client: PublicClient, chain: { outOfGas: readonly OutOfGasShape[] }): ChainReader {
  const capped = mapCappedReadError(chain.outOfGas);
  return {
    getCode: async (address) => {
      const code = await client.getCode({ address });
      return code && code !== "0x" ? code : null;
    },
    getStorageAt: async (address, slot, blockNumber) =>
      (await client.getStorageAt({ address, slot, ...(blockNumber === undefined ? {} : { blockNumber }) })) ?? null,
    // The function name is dynamic here, so viem's per-ABI inference can't apply; the checks cast the result.
    // viem's readContract hands everything it isn't typed for on to eth_call, `gas` included; `blockNumber` becomes the
    // call's block parameter.
    read: (address, abi: Abi, functionName, args = [], options) =>
      client.readContract({
        address,
        abi,
        functionName,
        args,
        ...(options?.gas === undefined ? {} : { gas: options.gas }),
        ...(options?.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
      } as Parameters<PublicClient["readContract"]>[0])
        .catch(options?.gas === undefined ? mapReadError : capped),
    blockNumber: () => client.getBlockNumber(),
    gasPrice: () => client.getGasPrice(),
    // Raw, since viem's getLogs takes one event's typed arguments and this filter is the RPC's own.
    logs: async ({ address, topics, fromBlock, toBlock }) => {
      const request = client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<unknown>;
      const logs = (await request({
        method: "eth_getLogs",
        params: [{ address, topics, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
      })) as readonly { topics: readonly Hex[]; data: Hex; blockNumber: Hex; removed?: boolean }[];
      return logs.filter((log) => !log.removed).map((log) => ({ topics: log.topics, data: log.data, blockNumber: BigInt(log.blockNumber) }));
    },
    // With `account` and `gas` set, viem never folds this call into a multicall batch. A storage write (`stateDiff`) goes
    // with its account only when there is one.
    callWithOverride: async (call, overrides) => {
      try {
        const { data } = await client.call({
          account: call.from,
          to: call.to,
          data: call.data,
          gas: call.gas,
          gasPrice: call.gasPrice,
          stateOverride: overrides.map((o) => ({ address: o.address, code: o.code, balance: o.balance, ...(o.stateDiff ? { stateDiff: o.stateDiff } : {}) })),
        });
        return data ?? "0x";
      } catch (e) {
        return capped(e);
      }
    },
  };
}
