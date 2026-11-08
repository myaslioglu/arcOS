import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import { ARCOS, DEX, KNOWN_LOCKERS, USDC, type Address } from "../addresses";
import { checkArcosAddresses } from "../addressSanity";
import { CHAINS, explorerUrl, type NetworkId } from "../chains";
import { INSPECT_CHAINS, arcInspectChain, chainExplorerUrl, inspectChain, type InspectChain } from "../inspect-chains";

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
      ]
    : []),
  ...(c.nativeQuote ? [c.nativeQuote.address] : []),
  ...(c.tradeQuote ? [c.tradeQuote.token] : []),
  ...c.knownLockers,
  ...(c.arcosTokenFactory ? [c.arcosTokenFactory] : []),
];

describe("the Inspector's chain registry", () => {
  it("has Arc, and only Arc, on each network", () => {
    expect(INSPECT_CHAINS.mainnet.map((c) => c.key)).toEqual(["arc"]);
    expect(INSPECT_CHAINS.testnet.map((c) => c.key)).toEqual(["arc"]);
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
      for (const a of [c.nativeQuote?.address, c.tradeQuote?.token].filter((x): x is Address => x !== undefined)) {
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
      expect(arc.nativeQuote, n).toEqual({ address: "0x0000000000000000000000000000000000000000", symbol: "USDC", decimals: 18, usd: "stable" });
      expect(arc.nativeQuote, n).toMatchObject({ symbol: CHAINS[n].nativeCurrency.symbol, decimals: CHAINS[n].nativeCurrency.decimals });
      expect(arc.tradeQuote, n).toEqual({ token: USDC, balanceSlot: null });
      expect(arc.tradeQuote?.token).toBe("0x3600000000000000000000000000000000000000");
      // The trade quote is one of the DEX config's quote tokens, so pools against it are found.
      expect(arc.dex?.quoteTokens.find((q) => q.address === arc.tradeQuote?.token)?.symbol, n).toBe("USDC");
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

  it("knows Arc's out-of-gas answer, -32003 \"out of gas…\", and nothing else", () => {
    for (const n of NETWORKS) {
      const shapes = arcInspectChain(n).outOfGas;
      const matches = (code: number, text: string) => shapes.some((s) => s.code === code && s.text.test(text));
      expect(matches(-32003, "out of gas: gas required exceeds: 2000000"), n).toBe(true);
      expect(matches(-32003, "Out of gas"), n).toBe(true);
      expect(matches(-32003, "revert: OutOfFunds"), n).toBe(false);
      expect(matches(-32000, "out of gas"), n).toBe(false);
      expect(matches(-32000, "intrinsic gas too low"), n).toBe(false);
      // Not a global regex: test() keeps no state between calls.
      for (const s of shapes) expect(s.text.global, n).toBe(false);
    }
  });

  it("marks every chain but Arc as having no vetted lockers until a list lands", () => {
    for (const [n, c] of all) if (c.key !== "arc") expect(c.lockersVetted, `${n} ${c.key}`).toBe(false);
  });

  it("finds a chain by key, and nothing for a key it doesn't have", () => {
    expect(inspectChain("mainnet", "arc")).toBe(arcInspectChain("mainnet"));
    expect(inspectChain("testnet", "arc")).toBe(arcInspectChain("testnet"));
    expect(inspectChain("mainnet", "base")).toBeNull();
    expect(inspectChain("mainnet", "ARC")).toBeNull();
  });

  it("links the chain's explorer as explorerUrl does for the site's chain", () => {
    for (const n of NETWORKS) {
      for (const kind of ["address", "tx", "token"] as const) {
        expect(chainExplorerUrl(arcInspectChain(n), kind, "0xabc"), `${n} ${kind}`).toBe(explorerUrl(kind, "0xabc", n));
      }
    }
  });
});
