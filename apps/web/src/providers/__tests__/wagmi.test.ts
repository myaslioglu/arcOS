import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicClient } from "@wagmi/core";
import { encodeErrorResult, encodeFunctionResult, multicall3Abi, parseAbi, type PublicClient } from "viem";
import { CHAINS } from "@arcos/chain";
import { CallReverted, viemReader } from "@arcos/inspector";
import { visibleConnectors, wagmiConfig } from "../wagmi";

type FakeConnector = { id: string; name: string };

const generic: FakeConnector = { id: "injected", name: "Injected" };
const metamask: FakeConnector = { id: "io.metamask", name: "MetaMask" };
const rabby: FakeConnector = { id: "io.rabby", name: "Rabby Wallet" };

describe("visibleConnectors", () => {
  it("hides the generic injected() connector once a real wallet is discovered", () => {
    expect(visibleConnectors([generic, metamask], true)).toEqual([metamask]);
  });

  it("hides the generic connector even when no window.ethereum flag is passed, as long as a wallet was discovered", () => {
    expect(visibleConnectors([generic, metamask], false)).toEqual([metamask]);
  });

  it("keeps every discovered wallet when more than one is installed", () => {
    expect(visibleConnectors([generic, metamask, rabby], true)).toEqual([metamask, rabby]);
  });

  it("falls back to the generic connector when nothing was discovered but a provider exists", () => {
    expect(visibleConnectors([generic], true)).toEqual([generic]);
  });

  it("returns an empty list when nothing was discovered and there is no injected provider", () => {
    expect(visibleConnectors([generic], false)).toEqual([]);
  });

  it("returns an empty list for an empty connector list regardless of the provider flag", () => {
    expect(visibleConnectors([], true)).toEqual([]);
    expect(visibleConnectors([], false)).toEqual([]);
  });
});

// The browser's reads (the Inspector window, Drop, Mint) all go through this config's clients, and the Inspector reads
// contracts anyone can deploy. A token's OffchainLookup revert must not make the visitor's browser fetch URLs the token
// chose (EIP-3668's CCIP-Read).
describe("wagmiConfig's clients and a token's OffchainLookup revert (CCIP-Read)", () => {
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const GATEWAY = "https://gateway.attacker.test";
  const OFFCHAIN_LOOKUP = encodeErrorResult({
    abi: parseAbi(["error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)"]),
    errorName: "OffchainLookup",
    args: [TOKEN, [`${GATEWAY}/{sender}/{data}`], "0x", "0x12345678", "0x"],
  });
  const MULTICALL3 = CHAINS.mainnet.contracts?.multicall3?.address.toLowerCase();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads it as a revert and never fetches the URL the token named", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith(GATEWAY)) return new Response("no", { status: 500 });
      const { params } = JSON.parse(String(init?.body)) as { params: [{ to?: string }] };
      const reply = (body: object) => Response.json({ jsonrpc: "2.0", id: 1, ...body });
      // wagmi batches reads through Multicall3: the batch succeeds, and the token's call inside it reverts.
      if (params[0].to?.toLowerCase() === MULTICALL3) {
        return reply({ result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: [{ success: false, returnData: OFFCHAIN_LOOKUP }] }) });
      }
      return reply({ error: { code: 3, message: "execution reverted", data: OFFCHAIN_LOOKUP } });
    });
    const client = getPublicClient(wagmiConfig, { chainId: CHAINS.mainnet.id }) as unknown as PublicClient;
    await expect(viemReader(client).read(TOKEN, parseAbi(["function owner() view returns (address)"]), "owner")).rejects.toBeInstanceOf(CallReverted);
    expect(fetched.filter((u) => u.startsWith(GATEWAY))).toEqual([]);
  });
});
