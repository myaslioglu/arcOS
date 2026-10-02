import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeErrorResult, parseAbi } from "viem";
import { CHAINS } from "@arcos/chain";
import { inspect } from "../inspect";
import { viemReader } from "../reader";
import { CallReverted } from "../types";
import { inspectionClient } from "../inspection-client";

const TOKEN = "0x1111111111111111111111111111111111111111";
const GATEWAY = "https://gateway.attacker.test";
/** EIP-3668's "look this up at GATEWAY", sent by the token itself (viem only follows it when the sender is the contract
 * called). */
const OFFCHAIN_LOOKUP = encodeErrorResult({
  abi: parseAbi(["error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)"]),
  errorName: "OffchainLookup",
  args: [TOKEN, [`${GATEWAY}/{sender}/{data}`], "0x", "0x12345678", "0x"],
});

/** A node where the token has plain code and every eth_call reverts with OffchainLookup. Records every URL fetched. */
function node() {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url.startsWith(GATEWAY)) return new Response("no", { status: 500 });
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    const reply = (body: object) => Response.json({ jsonrpc: "2.0", id: 1, ...body });
    if (method === "eth_getCode") return reply({ result: "0x63a9059cbb00" });
    if (method === "eth_getStorageAt") return reply({ result: `0x${"0".repeat(64)}` });
    if (method === "eth_blockNumber") return reply({ result: "0x1" });
    return reply({ error: { code: 3, message: "execution reverted", data: OFFCHAIN_LOOKUP } });
  });
  return { gatewayFetches: () => fetched.filter((u) => u.startsWith(GATEWAY)) };
}

describe("the server's inspection client and a token's OffchainLookup revert (CCIP-Read)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads it as a revert and never fetches the URL the token named", async () => {
    const { gatewayFetches } = node();
    const reader = viemReader(inspectionClient(CHAINS.mainnet));
    await expect(reader.read(TOKEN, parseAbi(["function owner() view returns (address)"]), "owner")).rejects.toBeInstanceOf(CallReverted);
    expect(gatewayFetches()).toEqual([]);
  });

  it("fetches nothing the token named during a whole inspection, and the report isn't degraded", async () => {
    const { gatewayFetches } = node();
    const r = await inspect({
      address: TOKEN, network: "mainnet", reader: viemReader(inspectionClient(CHAINS.mainnet)),
      explorer: null, dex: null, knownLockers: [], explorerBase: "https://explorer.test",
    });
    expect(gatewayFetches()).toEqual([]);
    expect(r.degraded).toBe(false);
  });
});
