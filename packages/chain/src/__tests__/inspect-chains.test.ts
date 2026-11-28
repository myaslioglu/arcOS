import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import { ARCOS, DEX, KNOWN_LOCKERS, USDC, type Address } from "../addresses";
import { USDC_DECIMALS } from "../amounts";
import { checkArcosAddresses } from "../addressSanity";
import { CHAINS, explorerUrl, type NetworkId } from "../chains";
import {
  INSPECT_CHAINS, arcInspectChain, chainExplorerUrl, enabledChainSlugs, enabledInspectChain, enabledInspectChains, inspectChain, otherExplorerUrl,
  type InspectChain,
} from "../inspect-chains";

const NETWORKS: NetworkId[] = ["mainnet", "testnet"];
const all = NETWORKS.flatMap((n) => INSPECT_CHAINS[n].map((c) => [n, c] as const));

/** Every address an entry names. */
const addressesOf = (c: InspectChain): Address[] => [
  ...(c.dex
    ? [
        ...c.dex.quoteTokens.map((q) => q.address),
        ...(c.dex.v2Factory ? [c.dex.v2Factory] : []),
        ...(c.dex.v3Factory ? [c.dex.v3Factory] : []),
        ...(c.dex.v4 ? Object.values(c.dex.v4) : []),
        ...(c.dex.aero ? [c.dex.aero.clFactory, c.dex.aero.positionManager] : []),
        ...(c.dex.solidly ? [c.dex.solidly.factory] : []),
      ]
    : []),
  ...(c.nativeQuote ? [c.nativeQuote.address, ...(c.nativeQuote.erc20View ? [c.nativeQuote.erc20View] : [])] : []),
  ...(c.tradeQuote ? [c.tradeQuote.token] : []),
  ...c.knownLockers,
  ...(c.arcosTokenFactory ? [c.arcosTokenFactory] : []),
];

describe("the Inspector's chain registry", () => {
  it("has Arc first on each network, and Ethereum, Base, Arbitrum One and OP Mainnet on mainnet only", () => {
    expect(INSPECT_CHAINS.mainnet.map((c) => c.key)).toEqual(["arc", "ethereum", "base", "arbitrum", "optimism"]);
    expect(INSPECT_CHAINS.testnet.map((c) => c.key)).toEqual(["arc"]);
    expect(INSPECT_CHAINS.mainnet.slice(1).map((c) => [c.name, c.chainId, c.slug])).toEqual([
      ["Ethereum", 1, "ethereum"],
      ["Base", 8453, "base"],
      ["Arbitrum One", 42161, "arbitrum"],
      ["OP Mainnet", 10, "optimism"],
    ]);
  });

  it("has unique keys and slugs on each network, and each chain id is its viem chain's", () => {
    for (const n of NETWORKS) {
      const chains = INSPECT_CHAINS[n];
      expect(new Set(chains.map((c) => c.key)).size, n).toBe(chains.length);
      expect(new Set(chains.map((c) => c.slug)).size, n).toBe(chains.length);
      for (const c of chains) expect(c.chainId, `${n} ${c.key}`).toBe(c.viem.id);
    }
  });

  it("names only well-formed addresses, checksummed where the registry writes them itself", () => {
    for (const [n, c] of all) {
      for (const a of addressesOf(c)) expect(isAddress(a, { strict: false }), `${n} ${c.key} ${a}`).toBe(true);
      // The DEX config, the lockers and ARCOS are addresses.ts's (and checked there); the quotes are the registry's own.
      for (const a of [c.nativeQuote?.address, c.nativeQuote?.erc20View, c.tradeQuote?.token].filter((x): x is Address => typeof x === "string")) {
        expect(getAddress(a), `${n} ${c.key}`).toBe(a);
      }
    }
    // The TokenFactory each Arc entry names is the one ARCOS names, which passes the shape check.
    for (const n of NETWORKS) expect(checkArcosAddresses(ARCOS[n])).toEqual({ status: "ok" });
  });

  it("builds Arc's entries from CHAINS, DEX, ARCOS and KNOWN_LOCKERS, so they can't drift", () => {
    for (const n of NETWORKS) {
      const arc = arcInspectChain(n);
      expect(arc.viem, n).toBe(CHAINS[n]);
      expect(arc.chainId, n).toBe(CHAINS[n].id);
      expect(arc.name, n).toBe(CHAINS[n].name);
      expect(arc.explorer, n).toEqual({ url: CHAINS[n].blockExplorers!.default.url, publicApiUrl: CHAINS[n].blockExplorers!.default.apiUrl });
      expect(arc.dex, n).toBe(DEX[n]);
      expect(arc.knownLockers, n).toBe(KNOWN_LOCKERS[n]);
      expect(arc.arcosTokenFactory, n).toBe(ARCOS[n]!.tokenFactory);
      expect(arc.otherExplorer, n).toBeNull();
    }
    expect(arcInspectChain("mainnet").chainId).toBe(5042);
    expect(arcInspectChain("testnet").chainId).toBe(5042002);
  });

  it("gives Arc what the engine used to assume: native USDC with 18 decimals, and USDC at 0x3600 funded by the native balance", () => {
    for (const n of NETWORKS) {
      const arc = arcInspectChain(n);
      expect(arc.nativeQuote, n).toEqual({ address: "0x0000000000000000000000000000000000000000", symbol: "USDC", decimals: 18, usd: "stable", erc20View: USDC });
      expect(arc.nativeQuote, n).toMatchObject({ symbol: CHAINS[n].nativeCurrency.symbol, decimals: CHAINS[n].nativeCurrency.decimals });
      expect(arc.tradeQuote, n).toEqual({ token: USDC, decimals: USDC_DECIMALS, balanceSlot: null });
      expect(arc.tradeQuote).toMatchObject({ token: "0x3600000000000000000000000000000000000000", decimals: 6 });
      expect(arc.lockersVetted, n).toBe(true);
      expect(arc.unscanned, n).toEqual([]);
      expect(arc.slug, n).toBe("arc");
    }
  });

  it("keeps Arc's PREVRANDAO wording and evidence exactly", () => {
    for (const n of NETWORKS) {
      expect(arcInspectChain(n).prevrandao).toEqual({
        warnTitle: "Uses PREVRANDAO, which is always 0 on Arc",
        detail: "Any randomness derived from it is predictable.",
        evidenceUrl: "https://docs.arc.io/arc/references/evm-differences",
      });
    }
  });

  it("trades, where it trades, against one of the chain's DEX quote tokens, funded through the native balance only by its ERC-20 view", () => {
    for (const [n, c] of all) {
      if (!c.tradeQuote) continue;
      // Pools against the trade quote are found, and named by its symbol, only if it is one of the DEX config's quotes.
      expect(c.dex?.quoteTokens.some((q) => q.address === c.tradeQuote!.token), `${n} ${c.key}`).toBe(true);
      if (c.tradeQuote.balanceSlot === null) expect(c.nativeQuote?.erc20View, `${n} ${c.key}`).toBe(c.tradeQuote.token);
    }
  });

  it("names what discovery can't see off Arc, and nothing on Arc, where every pool kind is read", () => {
    // The liquidity check reads the list: "no pool" and "thin" are unknown wherever a kind of pool goes unread.
    for (const n of NETWORKS) expect(arcInspectChain(n).unscanned, n).toEqual([]);
    for (const c of INSPECT_CHAINS.mainnet.slice(1)) {
      expect(c.unscanned[0], c.key).toBe("Uniswap v4 pools with a hook or an unusual fee");
      expect(c.unscanned.at(-1), c.key).toBe("pools on other DEXes");
      // Where Slipstream is read, the pools of its second factory aren't.
      expect(c.unscanned.includes("Slipstream pools from other factories"), c.key).toBe(Boolean(c.dex?.aero));
    }
  });

  it("knows Arc's out-of-gas answer, -32003 \"out of gas…\", and nothing else", () => {
    for (const n of NETWORKS) {
      const shapes = arcInspectChain(n).outOfGas;
      const matches = (code: number, text: string) => shapes.some((s) => s.code === code && s.text.test(text));
      expect(matches(-32003, "out of gas: gas required exceeds: 2000000"), n).toBe(true);
      expect(matches(-32003, "Out of gas"), n).toBe(true);
      expect(matches(-32003, "revert: OutOfFunds"), n).toBe(false);
      expect(matches(-32000, "out of gas"), n).toBe(false);
      expect(matches(-32000, "intrinsic gas too low"), n).toBe(false);
    }
  });

  it("gives every chain out-of-gas patterns that keep no state: neither global nor sticky", () => {
    // A global or sticky RegExp's test() moves its lastIndex, so the same answer could match once and not the next time.
    for (const [n, c] of all) {
      for (const s of c.outOfGas) expect([s.text.global, s.text.sticky], `${n} ${c.key} ${s.text}`).toEqual([false, false]);
    }
  });

  it("marks every chain but Arc as having no vetted lockers until a list lands", () => {
    for (const [n, c] of all) if (c.key !== "arc") expect(c.lockersVetted, `${n} ${c.key}`).toBe(false);
  });

  it("asks Sourcify off Arc, and lets an explorer's \"not verified\" fail a token only on Arc", () => {
    for (const [n, c] of all) {
      expect(c.sourcify, `${n} ${c.key}`).toBe(c.key !== "arc");
      expect(c.unverifiedFails, `${n} ${c.key}`).toBe(c.key === "arc");
    }
  });

  it("finds a chain by key, and nothing for a key it doesn't have", () => {
    expect(inspectChain("mainnet", "arc")).toBe(arcInspectChain("mainnet"));
    expect(inspectChain("testnet", "arc")).toBe(arcInspectChain("testnet"));
    expect(inspectChain("mainnet", "base")?.chainId).toBe(8453);
    expect(inspectChain("testnet", "base")).toBeNull();
    expect(inspectChain("mainnet", "ARC")).toBeNull();
    expect(inspectChain("mainnet", "polygon")).toBeNull();
  });

  it("links another explorer beside the address off Arc, and none on Arc", () => {
    const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    expect(otherExplorerUrl(inspectChain("mainnet", "ethereum")!, "token", usdc)).toBe(`https://etherscan.io/token/${usdc}`);
    expect(otherExplorerUrl(inspectChain("mainnet", "base")!, "address", usdc)).toBe(`https://basescan.org/address/${usdc}`);
    expect(otherExplorerUrl(inspectChain("mainnet", "arbitrum")!, "token", usdc)).toBe(`https://arbiscan.io/token/${usdc}`);
    expect(otherExplorerUrl(inspectChain("mainnet", "optimism")!, "token", usdc)).toBe(`https://optimistic.etherscan.io/token/${usdc}`);
    for (const n of NETWORKS) expect(otherExplorerUrl(arcInspectChain(n), "token", usdc)).toBeNull();
    // Evidence links go to the chain's Blockscout, where the data came from.
    expect(chainExplorerUrl(inspectChain("mainnet", "base")!, "token", usdc)).toBe(`https://base.blockscout.com/token/${usdc}`);
  });

  it("links the chain's explorer as explorerUrl does for the site's chain", () => {
    for (const n of NETWORKS) {
      for (const kind of ["address", "tx", "token"] as const) {
        expect(chainExplorerUrl(arcInspectChain(n), kind, "0xabc"), `${n} ${kind}`).toBe(explorerUrl(kind, "0xabc", n));
      }
    }
  });
});

describe("Ethereum, Base, Arbitrum One and OP Mainnet in the registry", () => {
  const others = INSPECT_CHAINS.mainnet.filter((c) => c.key !== "arc");
  const byKey = (key: string) => inspectChain("mainnet", key)!;

  it("writes every address checksummed, and each chain's addresses are distinct", () => {
    for (const c of others) {
      const addresses = addressesOf(c).filter((a) => a !== "0x0000000000000000000000000000000000000000");
      for (const a of addresses) expect(getAddress(a), `${c.key} ${a}`).toBe(a);
      // The trade quote is the chain's USDC, which is also its first quote token: the rest are all different contracts.
      const distinct = new Set(addresses.map((a) => a.toLowerCase()));
      expect(distinct.size, c.key).toBe(addresses.length - 1);
    }
  });

  it("quotes against USDC first, with USDT where there is one, then WETH: the dollars stable, WETH not priced yet", () => {
    const quotes = (key: string) => byKey(key).dex!.quoteTokens.map((q) => [q.symbol, q.decimals, q.usd]);
    const usdc = ["USDC", 6, "stable"];
    const usdt = ["USDT", 6, "stable"];
    const weth = ["WETH", 18, "unpriced"];
    expect(quotes("ethereum")).toEqual([usdc, usdt, weth]);
    expect(quotes("base")).toEqual([usdc, weth]);
    expect(quotes("arbitrum")).toEqual([usdc, usdt, weth]);
    expect(quotes("optimism")).toEqual([usdc, usdt, weth]);
    // Native ETH is a v4 quote too, unpriced, and no ERC-20 shows its balances.
    for (const c of others) expect(c.nativeQuote, c.key).toEqual({ address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18, usd: "unpriced", erc20View: null });
  });

  it("buys with USDC in the trade check, funded through its balance mapping at slot 9", () => {
    for (const c of others) {
      expect(c.tradeQuote, c.key).toEqual({ token: c.dex!.quoteTokens[0]!.address, decimals: 6, balanceSlot: 9 });
    }
  });

  it("reads Uniswap v2, v3 and v4 everywhere, and Slipstream and the classic pools on Base and OP Mainnet only", () => {
    for (const c of others) {
      expect(c.dex?.v2Factory, c.key).toBeDefined();
      expect(c.dex?.v3FeeTiers, c.key).toEqual([100, 500, 3000, 10000]);
      expect(Object.keys(c.dex!.v4!).sort(), c.key).toEqual(["poolManager", "positionManager", "quoter", "stateView"]);
    }
    expect([byKey("base").dex!.aero!.name, byKey("base").dex!.solidly!.name]).toEqual(["Aerodrome Slipstream", "Aerodrome classic"]);
    expect([byKey("optimism").dex!.aero!.name, byKey("optimism").dex!.solidly!.name]).toEqual(["Velodrome Slipstream", "Velodrome classic"]);
    for (const key of ["base", "optimism"]) expect(byKey(key).dex!.aero!.tickSpacings, key).toEqual([1, 10, 50, 100, 200, 2000]);
    for (const key of ["ethereum", "arbitrum"]) {
      expect(byKey(key).dex!.aero, key).toBeUndefined();
      expect(byKey(key).dex!.solidly, key).toBeUndefined();
    }
  });

  it("knows each chain's measured out-of-gas answer: -32003 on geth and op-geth, -32000 on Arbitrum's Nitro", () => {
    const matches = (key: string, code: number, text: string) => byKey(key).outOfGas.some((s) => s.code === code && s.text.test(text));
    for (const key of ["ethereum", "base", "optimism"]) {
      expect(matches(key, -32003, "out of gas: gas required exceeds: 100000"), key).toBe(true);
      expect(matches(key, -32000, "out of gas"), key).toBe(false);
    }
    expect(matches("arbitrum", -32000, "out of gas: gas required exceeds: 100000")).toBe(true);
    expect(matches("arbitrum", -32000, "out of gas")).toBe(true);
    expect(matches("arbitrum", -32003, "out of gas")).toBe(false);
    // A gas limit under the intrinsic cost is a refusal on every chain, in every wording measured.
    for (const c of others) {
      for (const text of ["intrinsic gas too low", "err: intrinsic gas too low: have 20000, want 21000 (supplied gas 20000)"]) {
        expect(c.outOfGas.some((s) => s.text.test(text)), `${c.key} ${text}`).toBe(false);
      }
    }
  });

  it("words PREVRANDAO for each chain in a title that fits one row of the social card", () => {
    expect(others.map((c) => c.prevrandao.warnTitle)).toEqual([
      "Uses PREVRANDAO, which validators can bias",
      "Uses PREVRANDAO, predictable on Base",
      "Uses PREVRANDAO, always 1 on Arbitrum",
      "Uses PREVRANDAO, predictable on OP Mainnet",
    ]);
    for (const c of INSPECT_CHAINS.mainnet) {
      expect(c.prevrandao.warnTitle.length, c.key).toBeLessThanOrEqual(43);
      expect(c.prevrandao.evidenceUrl, c.key).toMatch(/^https:\/\//);
    }
  });

  it("keeps a public RPC behind the server's keyed provider, and no key in the registry", () => {
    expect(others.map((c) => c.viem.rpcUrls.default.http)).toEqual([
      ["https://ethereum-rpc.publicnode.com"],
      ["https://mainnet.base.org"],
      ["https://arb1.arbitrum.io/rpc"],
      ["https://mainnet.optimism.io"],
    ]);
    expect(JSON.stringify(INSPECT_CHAINS, (_, v) => (v instanceof RegExp ? String(v) : v))).not.toMatch(/alchemy/i);
  });

  it("links evidence to each chain's Blockscout, which no browser reads from here", () => {
    expect(others.map((c) => c.explorer)).toEqual([
      { url: "https://eth.blockscout.com", publicApiUrl: null },
      { url: "https://base.blockscout.com", publicApiUrl: null },
      { url: "https://arbitrum.blockscout.com", publicApiUrl: null },
      { url: "https://optimism.blockscout.com", publicApiUrl: null },
    ]);
  });
});

describe("which chains are switched on (NEXT_PUBLIC_INSPECT_CHAINS)", () => {
  const keys = (chains: InspectChain[]) => chains.map((c) => c.key);

  it("switches on nothing but Arc while the flag is unset or empty", () => {
    for (const flag of [undefined, "", " , "]) {
      expect(keys(enabledInspectChains("mainnet", flag)), String(flag)).toEqual(["arc"]);
      expect(enabledInspectChain("mainnet", "base", flag), String(flag)).toBeNull();
    }
  });

  it("switches each chain on by its slug, on its own, in registry order whatever the flag's order", () => {
    expect(keys(enabledInspectChains("mainnet", "base"))).toEqual(["arc", "base"]);
    expect(keys(enabledInspectChains("mainnet", "optimism, ethereum"))).toEqual(["arc", "ethereum", "optimism"]);
    expect(keys(enabledInspectChains("mainnet", "ethereum,base,arbitrum,optimism"))).toEqual(["arc", "ethereum", "base", "arbitrum", "optimism"]);
    expect(enabledInspectChain("mainnet", "arbitrum", "ethereum,base,arbitrum,optimism")?.chainId).toBe(42161);
  });

  it("ignores what isn't a slug, a key spelled otherwise included, and never switches Arc off", () => {
    expect(keys(enabledInspectChains("mainnet", "polygon,BASE,eth,arc"))).toEqual(["arc"]);
    expect(enabledChainSlugs("arc,base")).toEqual(new Set(["base"]));
    expect(enabledInspectChain("mainnet", "arc", "")).toBe(arcInspectChain("mainnet"));
  });

  it("has nothing but Arc on testnet, whatever the flag says", () => {
    expect(keys(enabledInspectChains("testnet", "ethereum,base,arbitrum,optimism"))).toEqual(["arc"]);
    expect(enabledInspectChain("testnet", "base", "base")).toBeNull();
  });

  it("reads the flag from the environment when given none", () => {
    const before = process.env.NEXT_PUBLIC_INSPECT_CHAINS;
    try {
      process.env.NEXT_PUBLIC_INSPECT_CHAINS = "base";
      expect(keys(enabledInspectChains("mainnet"))).toEqual(["arc", "base"]);
      delete process.env.NEXT_PUBLIC_INSPECT_CHAINS;
      expect(keys(enabledInspectChains("mainnet"))).toEqual(["arc"]);
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_INSPECT_CHAINS;
      else process.env.NEXT_PUBLIC_INSPECT_CHAINS = before;
    }
  });
});
