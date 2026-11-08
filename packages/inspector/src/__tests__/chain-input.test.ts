import { describe, expect, it } from "vitest";
import { ARCOS, CHAINS, DEX, KNOWN_LOCKERS, USDC, arcInspectChain, type NetworkId } from "@arcos/chain";
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
    }
  });

  it("carries every field the engine reads about the chain, and nothing else", () => {
    expect(Object.keys(chainInput(arcInspectChain("mainnet"))).sort()).toEqual(
      ["arcosTokenFactory", "chain", "dex", "explorerBase", "knownLockers", "lockersVetted", "nativeQuote", "prevrandao", "tradeQuote", "unscanned"],
    );
  });
});
