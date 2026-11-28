import { describe, expect, it } from "vitest";
import { ARCOS, CHAINS, DEX, INSPECT_CHAINS, KNOWN_LOCKERS, USDC, arcInspectChain, type NetworkId } from "@arcos/chain";
import { chainInput } from "../chain-input";

describe("chainInput", () => {
  it("gives an inspection on Arc what the site and the indexer passed before the registry, and Arc's chain fields", () => {
    for (const network of ["mainnet", "testnet"] as NetworkId[]) {
      const input = chainInput(arcInspectChain(network));
      expect(input.dex, network).toBe(DEX[network]);
      expect(input.knownLockers, network).toBe(KNOWN_LOCKERS[network]);
      expect(input.explorerBase, network).toBe(CHAINS[network].blockExplorers!.default.url);
      expect(input.arcosTokenFactory, network).toBe(ARCOS[network]!.tokenFactory);
      expect(input.chain, network).toEqual({ key: "arc", name: CHAINS[network].name, chainId: CHAINS[network].id });
      expect(input.nativeQuote, network).toMatchObject({ address: "0x0000000000000000000000000000000000000000", symbol: "USDC", decimals: 18 });
      expect(input.tradeQuote, network).toEqual({ token: USDC, decimals: 6, balanceSlot: null });
      expect(input.nativeQuote?.erc20View, network).toBe(USDC);
      expect(input.lockersVetted, network).toBe(true);
      expect(input.unscanned, network).toEqual([]);
      expect(input.prevrandao.warnTitle, network).toBe("Uses PREVRANDAO, which is always 0 on Arc");
      expect(input.unverifiedFails, network).toBe(true);
    }
  });

  it("gives an inspection off Arc that chain's own fields: its Blockscout for evidence, its quotes and its rules", () => {
    for (const chain of INSPECT_CHAINS.mainnet.filter((c) => c.key !== "arc")) {
      const input = chainInput(chain);
      expect(input.chain, chain.key).toEqual({ key: chain.key, name: chain.name, chainId: chain.chainId });
      expect(input.dex, chain.key).toBe(chain.dex);
      expect(input.explorerBase, chain.key).toBe(chain.explorer.url);
      expect(input.explorerBase, chain.key).toMatch(/^https:\/\/[a-z]+\.blockscout\.com$/);
      expect(input.arcosTokenFactory, chain.key).toBeNull();
      expect(input.tradeQuote, chain.key).toEqual({ token: chain.dex!.quoteTokens[0]!.address, decimals: 6, balanceSlot: 9 });
      expect(input.nativeQuote, chain.key).toMatchObject({ symbol: "ETH", usd: "unpriced", erc20View: null });
      expect([input.lockersVetted, input.unverifiedFails], chain.key).toEqual([false, false]);
      expect(input.unscanned.length, chain.key).toBeGreaterThan(0);
      expect(input.prevrandao, chain.key).toBe(chain.prevrandao);
    }
  });

  it("carries every field the engine reads about the chain, and nothing else", () => {
    expect(Object.keys(chainInput(arcInspectChain("mainnet"))).sort()).toEqual(
      ["arcosTokenFactory", "chain", "dex", "explorerBase", "knownLockers", "lockersVetted", "nativeQuote", "prevrandao", "tradeQuote", "unscanned", "unverifiedFails"],
    );
  });
});
