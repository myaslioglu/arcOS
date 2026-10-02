import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicClient } from "wagmi/actions";
import { encodeErrorResult, encodeFunctionResult, multicall3Abi, parseAbi, type PublicClient } from "viem";
import { CHAINS } from "@arcos/chain";
import { CallReverted, viemReader } from "@arcos/inspector";
import { WALLETCONNECT_METADATA, connectorLabel, isWalletConnect, visibleConnectors, wagmiConfig, walletConnectMetadata } from "../wagmi";

type FakeConnector = { id: string; name: string };

const generic: FakeConnector = { id: "injected", name: "Injected" };
const metamask: FakeConnector = { id: "io.metamask", name: "MetaMask" };
const rabby: FakeConnector = { id: "io.rabby", name: "Rabby Wallet" };
const walletConnect: FakeConnector = { id: "walletConnect", name: "WalletConnect" };

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

// With WalletConnect configured the list gains one entry, and it must not change what the other entries do: the generic
// injected one still shows inside a wallet's own browser, where window.ethereum exists without an EIP-6963 announcement.
describe("visibleConnectors with WalletConnect", () => {
  it("offers only WalletConnect where the browser has no wallet at all, as on a phone", () => {
    expect(visibleConnectors([generic, walletConnect], false)).toEqual([walletConnect]);
  });

  it("lists the discovered wallets, then WalletConnect last", () => {
    expect(visibleConnectors([generic, walletConnect, metamask, rabby], true)).toEqual([metamask, rabby, walletConnect]);
    expect(visibleConnectors([generic, walletConnect, metamask], false)).toEqual([metamask, walletConnect]);
  });

  // The regression guard. A wallet's in-app browser injects window.ethereum without announcing itself over EIP-6963, so the
  // generic entry is the one that works there; WalletConnect must not count as a discovered wallet and hide it.
  it("keeps the generic injected entry beside WalletConnect when a provider exists but no wallet announced itself", () => {
    expect(visibleConnectors([generic, walletConnect], true)).toEqual([generic, walletConnect]);
  });

  it("puts WalletConnect last whatever order the connectors arrive in", () => {
    expect(visibleConnectors([walletConnect, generic, metamask], true)).toEqual([metamask, walletConnect]);
    expect(visibleConnectors([walletConnect, generic], true)).toEqual([generic, walletConnect]);
    expect(visibleConnectors([walletConnect, metamask, generic, rabby], false)).toEqual([metamask, rabby, walletConnect]);
  });

  it("lists WalletConnect alone when it is the only connector", () => {
    expect(visibleConnectors([walletConnect], false)).toEqual([walletConnect]);
    expect(visibleConnectors([walletConnect], true)).toEqual([walletConnect]);
  });

  it("gives exactly today's results when WalletConnect isn't configured", () => {
    // The rule before WalletConnect existed, written out, against every mix of the entries it could see.
    const before = (connectors: FakeConnector[], hasInjectedProvider: boolean) => {
      const discovered = connectors.filter((c) => c.id !== "injected");
      if (discovered.length > 0) return discovered;
      return hasInjectedProvider ? connectors.filter((c) => c.id === "injected") : [];
    };
    const mixes: FakeConnector[][] = [[], [generic], [metamask], [generic, metamask], [generic, metamask, rabby], [metamask, generic, rabby]];
    for (const mix of mixes) {
      for (const hasInjectedProvider of [true, false]) {
        expect(visibleConnectors(mix, hasInjectedProvider), `${mix.map((c) => c.id)} / ${hasInjectedProvider}`).toEqual(before(mix, hasInjectedProvider));
      }
    }
  });
});

describe("connectorLabel", () => {
  it("tells a phone user what WalletConnect is for", () => {
    expect(connectorLabel(walletConnect)).toBe("WalletConnect (phone wallets)");
  });

  it("leaves every other wallet's own name alone", () => {
    expect(connectorLabel(generic)).toBe("Injected");
    expect(connectorLabel(metamask)).toBe("MetaMask");
    expect(connectorLabel(rabby)).toBe("Rabby Wallet");
  });
});

// The Wallet window asks this of the connector it last tried, to know when WalletConnect's own modal is up.
describe("isWalletConnect", () => {
  it("is true for the WalletConnect connector only", () => {
    expect(isWalletConnect(walletConnect)).toBe(true);
    expect(isWalletConnect(generic)).toBe(false);
    expect(isWalletConnect(metamask)).toBe(false);
  });

  it("is false for what isn't a connector object: nothing yet, or a connector factory, which wagmi's connect also takes", () => {
    expect(isWalletConnect(undefined)).toBe(false);
    expect(isWalletConnect(null)).toBe(false);
    expect(isWalletConnect(() => walletConnect)).toBe(false);
  });
});

// WalletConnect is opt-in per build: the connector exists only when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID holds a value, and
// even then nothing of WalletConnect may start until a visitor picks it (see lazyWalletConnect).
describe("wagmiConfig's WalletConnect connector", () => {
  // Made up. The site's own project ID is a public value in apps/web/apphosting.yaml; no test needs it.
  const PROJECT_ID = "0123456789abcdef0123456789abcdef";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Next inlines NEXT_PUBLIC_ variables where the module is built; the test stubs the variable and loads the module afresh.
  async function configWith(projectId: string | undefined) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", projectId);
    return (await import("../wagmi")).wagmiConfig;
  }

  it("has only the injected connector when no project ID is set, or it is empty or blank", async () => {
    for (const value of [undefined, "", "   "]) {
      expect((await configWith(value)).connectors.map((c) => c.id), JSON.stringify(value)).toEqual(["injected"]);
    }
  });

  it("adds WalletConnect after injected() when a project ID is set", async () => {
    const config = await configWith(PROJECT_ID);
    expect(config.connectors.map((c) => c.id)).toEqual(["injected", "walletConnect"]);
    expect(config.connectors[1]?.name).toBe("WalletConnect");
  });

  // wagmi calls each connector's setup() while it builds the config, on the server too, and getProvider() for every connector
  // when the page reconnects. WalletConnect's own connector loads its provider and starts its client (which asks Reown for
  // the project's configuration) in both, for every visitor. Here it must do neither until a visitor picks it.
  it("starts nothing at import: no request, no setup() for wagmi to run, and no provider until a visitor picks it", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      throw new Error("no network in this test");
    });
    const config = await configWith(PROJECT_ID);
    const connector = config.connectors.find((c) => c.id === "walletConnect");
    expect(connector).toBeDefined();
    expect(connector?.setup).toBeUndefined();
    await expect(connector?.getProvider()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetched).toEqual([]);
  });

  it("keeps CCIP-Read off with WalletConnect in the config", async () => {
    const config = await configWith(PROJECT_ID);
    expect(config.getClient({ chainId: CHAINS.mainnet.id }).ccipRead).toBe(false);
  });
});

describe("WALLETCONNECT_METADATA", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("names the site the way wallets show it", () => {
    expect(WALLETCONNECT_METADATA.name).toBe("4rc.OS");
    expect(WALLETCONNECT_METADATA.description).toBe("Small token tools on Arc, as a desktop.");
    expect(WALLETCONNECT_METADATA.url).toBe("https://4rcos.com");
  });

  // Wallets fetch the icon themselves, so it has to be an absolute URL, and a route the app really serves.
  it("points its icon at a route the app serves", () => {
    const [icon, ...rest] = WALLETCONNECT_METADATA.icons;
    expect(rest).toEqual([]);
    const { origin, pathname } = new URL(icon ?? "");
    expect(origin).toBe(WALLETCONNECT_METADATA.url);
    const appDir = fileURLToPath(new URL("../../app", import.meta.url));
    expect(readdirSync(appDir).filter((f) => f.replace(/\.(tsx|ts)$/, "") === pathname.slice(1))).toEqual(["apple-icon.tsx"]);
  });

  // Wallets show the url, and WalletConnect's verify service checks it against the page's origin, so each site gives its
  // own: https://4rcos.com on mainnet, https://testnet.4rcos.com on testnet, from NEXT_PUBLIC_SITE_URL.
  it("takes the url and the icon from the site URL the build was given", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://testnet.4rcos.com");
    const { WALLETCONNECT_METADATA: testnet } = await import("../wagmi");
    expect(testnet.url).toBe("https://testnet.4rcos.com");
    expect(testnet.icons).toEqual(["https://testnet.4rcos.com/apple-icon"]);
    expect(testnet.name).toBe("4rc.OS");
  });

  it("uses the site URL's origin, whatever path or slash it ends with", () => {
    expect(walletConnectMetadata("https://4rcos.com/").url).toBe("https://4rcos.com");
    expect(walletConnectMetadata("https://testnet.4rcos.com/x/").icons).toEqual(["https://testnet.4rcos.com/apple-icon"]);
  });

  it("falls back to https://4rcos.com without a site URL, or with one that isn't an http(s) URL", () => {
    for (const value of [undefined, "", "  ", "not a url", "javascript:alert(1)", "ftp://4rcos.com"]) {
      const metadata = walletConnectMetadata(value);
      expect(metadata.url, JSON.stringify(value)).toBe("https://4rcos.com");
      expect(metadata.icons, JSON.stringify(value)).toEqual(["https://4rcos.com/apple-icon"]);
    }
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
