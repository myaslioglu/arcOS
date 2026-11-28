import { describe, expect, it } from "vitest";
import { parseInspectTarget } from "../inspect-target";

const LOWER = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CHECKSUMMED = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("parseInspectTarget", () => {
  it("reads a bare address, checksummed, naming no chain", () => {
    expect(parseInspectTarget(LOWER)).toEqual({ address: CHECKSUMMED, chain: null });
    expect(parseInspectTarget(`  ${CHECKSUMMED}\n`)).toEqual({ address: CHECKSUMMED, chain: null });
  });

  it("reads a chain prefix: the registry's slug or the chain's ERC-3770 short name", () => {
    const cases: [string, string][] = [
      ["base", "base"], ["ethereum", "ethereum"], ["arbitrum", "arbitrum"], ["optimism", "optimism"], ["arc", "arc"],
      ["eth", "ethereum"], ["arb1", "arbitrum"], ["oeth", "optimism"], ["BASE", "base"],
    ];
    for (const [prefix, chain] of cases) expect(parseInspectTarget(`${prefix}:${LOWER}`), prefix).toEqual({ address: CHECKSUMMED, chain });
    expect(parseInspectTarget(`polygon:${LOWER}`)).toBeNull();
  });

  it("names no chain for a key every object inherits, in a prefix, a host or a Uniswap path", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(parseInspectTarget(`${name}:${LOWER}`), name).toBeNull();
      expect(parseInspectTarget(`https://${name}/token/${LOWER}`), name).toBeNull();
      expect(parseInspectTarget(`https://app.uniswap.org/explore/tokens/${name}/${LOWER}`), name).toBeNull();
    }
  });

  it("reads CAIP-10, eip155:<chain id>:<address>, Arc's two networks included", () => {
    for (const [id, chain] of [[1, "ethereum"], [8453, "base"], [42161, "arbitrum"], [10, "optimism"], [5042, "arc"], [5042002, "arc"]] as const) {
      expect(parseInspectTarget(`eip155:${id}:${LOWER}`), String(id)).toEqual({ address: CHECKSUMMED, chain });
    }
    expect(parseInspectTarget(`eip155:137:${LOWER}`)).toBeNull();
  });

  it("reads an explorer's token or address page, with or without its scheme and www", () => {
    const pages: [string, string][] = [
      [`https://etherscan.io/token/${LOWER}`, "ethereum"],
      [`https://www.etherscan.io/address/${LOWER}#code`, "ethereum"],
      [`etherscan.io/token/${LOWER}?a=0x0000000000000000000000000000000000000001`, "ethereum"],
      [`https://basescan.org/token/${LOWER}`, "base"],
      [`https://arbiscan.io/address/${LOWER}`, "arbitrum"],
      [`https://optimistic.etherscan.io/token/${LOWER}`, "optimism"],
      [`https://eth.blockscout.com/token/${LOWER}?tab=holders`, "ethereum"],
      [`https://base.blockscout.com/address/${LOWER}?tab=contract`, "base"],
      [`https://arbitrum.blockscout.com/token/${LOWER}`, "arbitrum"],
      [`https://optimism.blockscout.com/token/${LOWER}`, "optimism"],
      [`https://explorer.arc.io/token/${LOWER}`, "arc"],
      [`https://explorer.testnet.arc.io/address/${LOWER}`, "arc"],
    ];
    for (const [url, chain] of pages) expect(parseInspectTarget(url), url).toEqual({ address: CHECKSUMMED, chain });
  });

  it("reads Uniswap's token page, and this site's own report links", () => {
    expect(parseInspectTarget(`https://app.uniswap.org/explore/tokens/base/${LOWER}`)).toEqual({ address: CHECKSUMMED, chain: "base" });
    expect(parseInspectTarget(`https://app.uniswap.org/explore/tokens/ethereum/NATIVE`)).toBeNull();
    expect(parseInspectTarget(`https://4rcos.com/t/${LOWER}`)).toEqual({ address: CHECKSUMMED, chain: "arc" });
    expect(parseInspectTarget(`https://4rcos.com/t/optimism/${LOWER}`)).toEqual({ address: CHECKSUMMED, chain: "optimism" });
    expect(parseInspectTarget(`https://testnet.4rcos.com/badge/${LOWER}`)).toEqual({ address: CHECKSUMMED, chain: "arc" });
    expect(parseInspectTarget(`https://4rcos.com/t/polygon/${LOWER}`)).toBeNull();
  });

  it("reads nothing else: DEX Screener's pair links, other hosts, other paths, broken addresses", () => {
    for (const text of [
      `https://dexscreener.com/base/${LOWER}`,
      `https://example.com/token/${LOWER}`,
      `https://etherscan.io/tx/0x${"ab".repeat(32)}`,
      `https://etherscan.io/token/${LOWER.slice(0, -1)}`,
      `javascript:alert(1)//etherscan.io/token/${LOWER}`,
      `ftp://etherscan.io/token/${LOWER}`,
      `base:${LOWER}extra`,
      `${LOWER}${LOWER.slice(2)}`,
      "",
      "hello",
    ]) {
      expect(parseInspectTarget(text), text).toBeNull();
    }
  });
});
