import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, encodeErrorResult, http,
  parseAbi, type PublicClient,
} from "viem";
import { viemReader } from "../reader";
import { isNodeAnswer } from "../rpc-errors";
import { CallReverted } from "../types";

const abi = parseAbi(["function foo() view returns (uint256)"]);
const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
/** Solidity's Error(string) revert payload. */
const REVERT_DATA = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["Ownable: caller is not the owner"] });

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

  it("maps a ContractFunctionExecutionError wrapping a ContractFunctionRevertedError with revert data to CallReverted", async () => {
    // The revert data is what makes it a revert: viem builds the same class, with no data, for a bare -32603 (below).
    const reverted = new ContractFunctionRevertedError({ abi, functionName: "foo", data: REVERT_DATA });
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

// Which node answers are reverts, read through viem's own HTTP transport with `fetch` stubbed, so each error reaches the
// reader wrapped exactly as it is in production. A revert is what the node says it is: code 3, a message or data that
// says "revert", or revert data. Every other JSON-RPC error, an HTTP failure and a timeout are the endpoint failing:
// never evidence about the contract. -32602 invalid params is the node's answer, but not a revert either.
describe("viemReader().read: which node answers are reverts", () => {
  afterEach(() => vi.unstubAllGlobals());

  const read = (respond: () => Response) => {
    vi.stubGlobal("fetch", async () => respond());
    const client = createPublicClient({ transport: http("https://rpc.test", { retryCount: 0 }) });
    return viemReader(client).read(ADDRESS, abi, "foo");
  };
  const rpcError = (code: number, message: string, data?: unknown, status = 200) => () =>
    Response.json({ jsonrpc: "2.0", id: 1, error: { code, message, ...(data === undefined ? {} : { data }) } }, { status });
  const result = (value: string) => () => Response.json({ jsonrpc: "2.0", id: 1, result: value });

  it.each([
    ["code 3, execution reverted", rpcError(3, "execution reverted", "0x")],
    ["code 3 with an Error(string) payload", rpcError(3, "execution reverted: Ownable: caller is not the owner", REVERT_DATA)],
    ["-32000 execution reverted", rpcError(-32000, "execution reverted")],
    ["-32003 revert: OutOfFunds (Arc)", rpcError(-32003, "revert: OutOfFunds")],
    ["-32603 whose message and data say it reverted", rpcError(-32603, "VM Exception while processing transaction: reverted with reason string", REVERT_DATA)],
    ["a revert carried by an HTTP 500", rpcError(3, "execution reverted", "0x", 500)],
    ["an empty answer (no such function)", result("0x")],
  ])("%s is a revert", async (_, respond) => {
    await expect(read(respond)).rejects.toBeInstanceOf(CallReverted);
  });

  it.each([
    ["-32603 upstream unavailable", rpcError(-32603, "upstream unavailable")],
    ["-32603 in an HTTP 503", rpcError(-32603, "upstream unavailable", undefined, 503)],
    ["-32005 in an HTTP 429", rpcError(-32005, "limit exceeded", undefined, 429)],
    ["-32007 request limit reached", rpcError(-32007, "10/second request limit reached")],
    ["-32000 without revert", rpcError(-32000, "header not found")],
    ["-32601 method not found", rpcError(-32601, "the method eth_call does not exist/is not available")],
    ["-1 unknown error", rpcError(-1, "unknown error")],
    ["an HTTP 502 with no JSON-RPC body", () => new Response("bad gateway", { status: 502 })],
  ])("%s is the endpoint failing, never a revert", async (_, respond) => {
    const e: unknown = await read(respond).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(CallReverted);
    expect(isNodeAnswer(e)).toBe(false);
  });

  it("-32602 invalid params is the node's answer, but not a revert", async () => {
    const e: unknown = await read(rpcError(-32602, "invalid argument 0: hex string has length 38")).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(CallReverted);
    expect(isNodeAnswer(e)).toBe(true);
  });
});
