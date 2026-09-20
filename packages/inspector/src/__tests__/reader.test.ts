import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, parseAbi, type PublicClient } from "viem";
import { viemReader } from "../reader";
import { CallReverted } from "../types";

const abi = parseAbi(["function foo() view returns (uint256)"]);
const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

function fakeClient(readContract: () => Promise<unknown>): PublicClient {
  return { readContract } as unknown as PublicClient;
}

describe("viemReader().read", () => {
  it("maps a ContractFunctionExecutionError wrapping a ContractFunctionZeroDataError to CallReverted", async () => {
    const zeroData = new ContractFunctionZeroDataError({ functionName: "foo" });
    const wrapped = new ContractFunctionExecutionError(zeroData, { abi, functionName: "foo" });
    const client = fakeClient(() => Promise.reject(wrapped));

    await expect(viemReader(client).read(ADDRESS, abi, "foo")).rejects.toBeInstanceOf(CallReverted);
  });

  it("maps a ContractFunctionExecutionError wrapping a ContractFunctionRevertedError to CallReverted", async () => {
    const reverted = new ContractFunctionRevertedError({ abi, functionName: "foo", message: "custom error" });
    const wrapped = new ContractFunctionExecutionError(reverted, { abi, functionName: "foo" });
    const client = fakeClient(() => Promise.reject(wrapped));

    await expect(viemReader(client).read(ADDRESS, abi, "foo")).rejects.toBeInstanceOf(CallReverted);
  });

  it("passes a transport failure through unchanged — it never becomes CallReverted", async () => {
    const boom = new Error("ETIMEDOUT");
    const client = fakeClient(() => Promise.reject(boom));

    await expect(viemReader(client).read(ADDRESS, abi, "foo")).rejects.toBe(boom);
  });
});
