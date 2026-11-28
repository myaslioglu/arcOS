import { describe, expect, it, vi } from "vitest";
import { INSPECT_CHAINS, arcInspectChain, inspectChain } from "@arcos/chain";

// A marker module that throws outside a server build.
vi.mock("server-only", () => ({}));

import { ALCHEMY_URLS, inspectRpcEndpoints, inspectRpcKey } from "../rpc-urls";

const KEY = "test-key-0123456789";

describe("inspectRpcKey", () => {
  it("reads the runtime secret, trimmed, and nothing for unset, empty or the word none", () => {
    expect(inspectRpcKey(` ${KEY}\n`)).toBe(KEY);
    for (const raw of [undefined, "", "  ", "none", " none "]) expect(inspectRpcKey(raw), String(raw)).toBeUndefined();
  });
});

describe("inspectRpcEndpoints", () => {
  const others = INSPECT_CHAINS.mainnet.filter((c) => c.key !== "arc");

  it("puts the keyed provider first, its key in the Authorization header, then the chain's public RPC", () => {
    for (const chain of others) {
      const endpoints = inspectRpcEndpoints(chain, KEY);
      expect(endpoints, chain.key).toEqual([
        { url: ALCHEMY_URLS[chain.key as keyof typeof ALCHEMY_URLS], headers: { authorization: `Bearer ${KEY}` } },
        { url: chain.viem.rpcUrls.default.http[0] },
      ]);
    }
  });

  it("never writes the key into a URL", () => {
    for (const chain of others) {
      for (const { url } of inspectRpcEndpoints(chain, KEY)) expect(url, chain.key).not.toContain(KEY);
    }
  });

  it("uses the public RPC alone without a key: dev, CI, the testnet site, or before the secret exists", () => {
    for (const chain of others) expect(inspectRpcEndpoints(chain, undefined), chain.key).toEqual([{ url: chain.viem.rpcUrls.default.http[0] }]);
  });

  it("reads the key from the environment when given none", () => {
    vi.stubEnv("INSPECT_RPC_KEY", KEY);
    expect(inspectRpcEndpoints(inspectChain("mainnet", "base")!)[0]).toMatchObject({ url: "https://base-mainnet.g.alchemy.com/v2" });
    vi.stubEnv("INSPECT_RPC_KEY", "none");
    expect(inspectRpcEndpoints(inspectChain("mainnet", "base")!)).toEqual([{ url: "https://mainnet.base.org" }]);
    vi.unstubAllEnvs();
  });

  it("never sends Arc through the provider: Arc keeps its own clients", () => {
    expect(inspectRpcEndpoints(arcInspectChain("mainnet"), KEY).map((e) => e.url)).toEqual(arcInspectChain("mainnet").viem.rpcUrls.default.http);
    expect(inspectRpcEndpoints(arcInspectChain("mainnet"), KEY).some((e) => e.headers)).toBe(false);
  });
});
