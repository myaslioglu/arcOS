import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfig, createStorage, http, type CreateConnectorFn } from "wagmi";
import { connect, disconnect, reconnect } from "wagmi/actions";
import { UserRejectedRequestError } from "viem";
import { CHAINS } from "@arcos/chain";
import { connectErrorMessage } from "@/lib/network";
import { WalletConnectLoadError, lazyWalletConnect } from "../lazyWalletConnect";

// wagmi's walletConnect() connector, with the two calls that would start WalletConnect (loading its provider, opening its
// client) swapped for spies, so a test can see whether they ran and hand back a fake provider. Everything else in the
// connector, connect() and disconnect() included, is wagmi's real code.
const inner = vi.hoisted(() => ({
  setup: vi.fn(async () => {}),
  getProvider: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("wagmi/connectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi/connectors")>();
  return {
    ...actual,
    walletConnect: (parameters: Parameters<typeof actual.walletConnect>[0]) => {
      const create = actual.walletConnect(parameters);
      return (config: Parameters<typeof create>[0]) => {
        const connector = create(config);
        connector.setup = inner.setup;
        connector.getProvider = inner.getProvider as typeof connector.getProvider;
        return connector;
      };
    },
  };
});

const { mainnet, testnet } = CHAINS;
const PROJECT_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const RECENT = "test.recentConnectorId";

/** Just what wagmi's walletConnect connector touches on a provider. */
function fakeProvider(overrides: Record<string, unknown> = {}) {
  return {
    accounts: [] as string[],
    chainId: mainnet.id,
    session: undefined as unknown,
    on: vi.fn(),
    removeListener: vi.fn(),
    connect: vi.fn(async () => {}),
    enable: vi.fn(async () => [ACCOUNT]),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

/** The listener wagmi's connector attached to the provider for an event, called the way the real provider would call it. */
function listener(provider: ReturnType<typeof fakeProvider>, event: string): () => void {
  const call = provider.on.mock.calls.findLast(([name]) => name === event);
  if (!call) throw new Error(`no "${event}" listener was attached`);
  return call[1] as () => void;
}

/** A config over a storage the test can read and pre-fill, the way a browser's localStorage outlives a page load. */
function makeConfig(store = new Map<string, string>(), { refuseRemoval = false } = {}) {
  const config = createConfig({
    chains: [mainnet, testnet],
    // isNewChainsStale off: the storage a real session leaves behind (its requested chains) isn't what these tests are about.
    connectors: [lazyWalletConnect({ projectId: PROJECT_ID, isNewChainsStale: false })],
    transports: { [mainnet.id]: http(), [testnet.id]: http() },
    storage: createStorage({
      key: "test",
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => {
          if (refuseRemoval) throw new Error("storage refused");
          store.delete(key);
        },
      },
    }),
  });
  const connector = config.connectors[0];
  if (!connector) throw new Error("no connector");
  return { config, connector, store };
}

const lastConnection = (walletId: string) => new Map([[RECENT, JSON.stringify(walletId)]]);

beforeEach(() => {
  inner.setup.mockClear();
  inner.getProvider.mockReset();
  inner.getProvider.mockImplementation(async () => fakeProvider());
});

describe("lazyWalletConnect: nothing starts until it is wanted", () => {
  it("is still wagmi's WalletConnect connector", () => {
    const { connector } = makeConfig();
    expect([connector.id, connector.name, connector.type]).toEqual(["walletConnect", "WalletConnect", "walletConnect"]);
  });

  it("does not run the connector's setup(), which wagmi calls while it builds the config", () => {
    const { connector } = makeConfig();
    expect(connector.setup).toBeUndefined();
    expect(inner.setup).not.toHaveBeenCalled();
    expect(inner.getProvider).not.toHaveBeenCalled();
  });

  it("does not load the provider when a page reloads with no WalletConnect connection to restore", async () => {
    const { config } = makeConfig();
    await reconnect(config);
    expect(inner.getProvider).not.toHaveBeenCalled();
    expect(config.state.status).toBe("disconnected");
  });

  it("does not load the provider when the browser's last connection was another wallet", async () => {
    const { config } = makeConfig(lastConnection("io.metamask"));
    await reconnect(config);
    expect(inner.getProvider).not.toHaveBeenCalled();
  });

  it("answers getProvider() with nothing, and loads nothing, before it is picked", async () => {
    const { connector } = makeConfig();
    await expect(connector.getProvider()).resolves.toBeUndefined();
    expect(inner.getProvider).not.toHaveBeenCalled();
  });
});

describe("lazyWalletConnect: a visitor picks it", () => {
  it("loads the provider and connects, then remembers WalletConnect as the last wallet", async () => {
    const provider = fakeProvider();
    inner.getProvider.mockResolvedValue(provider);
    const { config, connector, store } = makeConfig();
    const result = await connect(config, { connector, chainId: mainnet.id });
    expect(inner.getProvider).toHaveBeenCalled();
    expect(provider.connect).toHaveBeenCalledTimes(1);
    expect(result.accounts).toEqual([ACCOUNT]);
    expect(config.state.status).toBe("connected");
    expect(store.get(RECENT)).toBe(JSON.stringify("walletConnect"));
  });

  // What a wallet is asked to approve. wagmi's connect() sends the chains as optional ones, so a wallet that lacks one of
  // them still connects, and the config's own chains are the whole list: no other chain is asked for.
  it("asks the wallet for exactly the config's Arc chains, the one being connected first", async () => {
    const provider = fakeProvider();
    inner.getProvider.mockResolvedValue(provider);
    const { config, connector } = makeConfig();
    await connect(config, { connector, chainId: mainnet.id });
    expect(provider.connect).toHaveBeenCalledTimes(1);
    const [request] = provider.connect.mock.calls[0] as unknown as [{ optionalChains?: number[] }];
    const asked = request.optionalChains ?? [];
    expect(asked[0]).toBe(mainnet.id);
    expect([...asked].sort((a, b) => a - b)).toEqual(config.chains.map((chain) => chain.id).sort((a, b) => a - b));
    expect(asked).toHaveLength(2);
    // Nothing that would make a wallet refuse when it lacks a chain.
    expect(request).not.toHaveProperty("chains");
  });

  // The same error the Wallet window turns into a sentence. This runs wagmi's real connect(), so it shows what it throws.
  it("reads a closed WalletConnect modal as a cancelled request, and leaves nothing to restore", async () => {
    inner.getProvider.mockResolvedValue(
      fakeProvider({
        connect: vi.fn(async () => {
          // What @walletconnect/ethereum-provider rejects with when the modal is closed before a wallet answers.
          throw new Error("Connection request reset. Please try again.");
        }),
      }),
    );
    const { config, connector, store } = makeConfig();
    const error = await connect(config, { connector, chainId: mainnet.id }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UserRejectedRequestError);
    expect(connectErrorMessage(error)).toBe("You cancelled the request in your wallet.");
    expect(connectErrorMessage(error)).not.toMatch(/reset/i);
    expect(config.state.status).toBe("disconnected");
    expect(store.has(RECENT)).toBe(false);
  });
});

describe("lazyWalletConnect: after a WalletConnect connection", () => {
  it("restores it when the page reloads", async () => {
    const provider = fakeProvider({ accounts: [ACCOUNT], session: { topic: "t" } });
    inner.getProvider.mockResolvedValue(provider);
    const { config, store } = makeConfig(lastConnection("walletConnect"));
    await reconnect(config);
    expect(inner.getProvider).toHaveBeenCalled();
    expect(config.state.status).toBe("connected");
    expect(config.state.connections.size).toBe(1);
    // The session was restored, not asked for again.
    expect(provider.connect).not.toHaveBeenCalled();
    // And the record stays, so the next reload restores it too: only a session that is gone is forgotten.
    expect(store.get(RECENT)).toBe(JSON.stringify("walletConnect"));
  });

  it("stops loading on a reload once the visitor disconnects", async () => {
    inner.getProvider.mockResolvedValue(fakeProvider());
    const { config, connector, store } = makeConfig();
    await connect(config, { connector, chainId: mainnet.id });
    expect(store.get(RECENT)).toBe(JSON.stringify("walletConnect"));

    await disconnect(config, { connector });
    // wagmi keeps recentConnectorId after the last disconnect, which would load WalletConnect on every reload from then on.
    expect(store.has(RECENT)).toBe(false);

    inner.getProvider.mockClear();
    const { config: reloaded } = makeConfig(store);
    await reconnect(reloaded);
    expect(inner.getProvider).not.toHaveBeenCalled();
  });

  it("still disconnects when storage refuses to drop the record", async () => {
    inner.getProvider.mockResolvedValue(fakeProvider());
    const { config, connector } = makeConfig(new Map(), { refuseRemoval: true });
    await connect(config, { connector, chainId: mainnet.id });
    await expect(disconnect(config, { connector })).resolves.toBeUndefined();
    expect(config.state.status).toBe("disconnected");
  });

  it("leaves another wallet's record alone when it disconnects", async () => {
    inner.getProvider.mockResolvedValue(fakeProvider());
    const { config, connector, store } = makeConfig();
    await connect(config, { connector, chainId: mainnet.id });
    store.set(RECENT, JSON.stringify("io.metamask"));
    await disconnect(config, { connector });
    expect(store.get(RECENT)).toBe(JSON.stringify("io.metamask"));
  });
});

// wagmi only ever writes recentConnectorId. Two more ways a WalletConnect session ends leave it behind, and every load
// after that would start WalletConnect for a session that is gone: the wallet ends it, and it expires (they last 7 days).
describe("lazyWalletConnect: a session that ended without the app disconnecting", () => {
  it("forgets a session the wallet ends while the page is open, and the next reload loads nothing", async () => {
    const provider = fakeProvider();
    inner.getProvider.mockResolvedValue(provider);
    const { config, connector, store } = makeConfig();
    await connect(config, { connector, chainId: mainnet.id });
    expect(store.get(RECENT)).toBe(JSON.stringify("walletConnect"));

    // The wallet deletes the session: the provider calls the listener wagmi's connector attached when it connected.
    listener(provider, "session_delete")();
    await vi.waitFor(() => expect(store.has(RECENT)).toBe(false));
    expect(config.state.status).toBe("disconnected");

    inner.getProvider.mockClear();
    await reconnect(makeConfig(store).config);
    expect(inner.getProvider).not.toHaveBeenCalled();
  });

  // wagmi's onDisconnect asks for the provider, so it can fail (a provider that no longer loads, say). The session it was
  // told about has ended all the same, so the record must go whether or not wagmi's own handler got to the end.
  it("forgets the record even when wagmi's own handler for the ended session fails, and still fails as it did", async () => {
    inner.getProvider.mockResolvedValue(fakeProvider());
    const { config, connector, store } = makeConfig();
    await connect(config, { connector, chainId: mainnet.id });
    expect(store.get(RECENT)).toBe(JSON.stringify("walletConnect"));

    inner.getProvider.mockRejectedValue(new Error("provider gone"));
    await expect(connector.onDisconnect()).rejects.toThrow("provider gone");
    expect(store.has(RECENT)).toBe(false);
  });

  it("leaves another wallet's record alone when the wallet ends its session", async () => {
    inner.getProvider.mockResolvedValue(fakeProvider());
    const { config, connector, store } = makeConfig();
    await connect(config, { connector, chainId: mainnet.id });
    store.set(RECENT, JSON.stringify("io.metamask"));
    await connector.onDisconnect();
    expect(store.get(RECENT)).toBe(JSON.stringify("io.metamask"));
  });

  it("forgets a record whose session is gone on reload, so only that one reload loads WalletConnect", async () => {
    // The last connection was WalletConnect, but its session expired while the tab was closed: the provider has no accounts.
    const { config, store } = makeConfig(lastConnection("walletConnect"));
    await reconnect(config);
    expect(inner.getProvider).toHaveBeenCalled();
    expect(config.state.status).toBe("disconnected");
    expect(store.has(RECENT)).toBe(false);

    inner.getProvider.mockClear();
    await reconnect(makeConfig(store).config);
    expect(inner.getProvider).not.toHaveBeenCalled();
  });

  it("leaves another wallet's record alone when it finds no session to restore", async () => {
    const { connector, store } = makeConfig(lastConnection("io.metamask"));
    await expect(connector.isAuthorized()).resolves.toBe(false);
    expect(store.get(RECENT)).toBe(JSON.stringify("io.metamask"));
  });
});

// wagmi's connector keeps a provider load that failed, so after one bad load (a chunk that 404s after a deploy, a dropped
// connection) every click fails again until the page reloads. Telling that failure apart lets the window say so.
describe("lazyWalletConnect: a provider that fails to load", () => {
  const failedLoad = () => new Error("Failed to fetch dynamically imported module: https://4rcos.com/_next/static/chunks/0a1b.js");

  it("raises a load error, which reads as reload the page and never shows the failure's own words", async () => {
    inner.getProvider.mockRejectedValue(failedLoad());
    const { config, connector, store } = makeConfig();
    const error = await connect(config, { connector, chainId: mainnet.id }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WalletConnectLoadError);
    expect(connectErrorMessage(error)).toBe("WalletConnect couldn't load. Reload the page and try again.");
    expect(connectErrorMessage(error)).not.toMatch(/chunks|dynamically/);
    expect(config.state.status).toBe("disconnected");
    expect(store.has(RECENT)).toBe(false);
  });

  it("says so again on the next click, as wagmi's connector fails again until a reload", async () => {
    inner.getProvider.mockRejectedValue(failedLoad());
    const { config, connector } = makeConfig();
    for (const click of [1, 2]) {
      const error = await connect(config, { connector, chainId: mainnet.id }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(connectErrorMessage(error), `click ${click}`).toBe("WalletConnect couldn't load. Reload the page and try again.");
    }
  });

  // A wallet that won't take Arc's chains refuses with words of its own. Reloading the page wouldn't change that.
  it("does not mistake a wallet's refusal for a load failure", async () => {
    inner.getProvider.mockResolvedValue(
      fakeProvider({
        connect: vi.fn(async () => {
          throw new Error("User disapproved requested chains");
        }),
      }),
    );
    const { config, connector } = makeConfig();
    const error = await connect(config, { connector, chainId: mainnet.id }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(WalletConnectLoadError);
    expect(connectErrorMessage(error)).toBe("Your wallet couldn't connect. Try again.");
  });
});

// Why lazyWalletConnect exists: what wagmi does with any connector, and what its own WalletConnect connector then does.
// If wagmi stops doing these, the wrapper can go.
describe("what wagmi does that lazyWalletConnect holds back", () => {
  /** A connector reduced to the two calls that matter here, to see what wagmi itself does with one. */
  function probe() {
    const setup = vi.fn(async () => {});
    const getProvider = vi.fn(async () => undefined);
    const create = (() => ({ id: "probe", name: "Probe", type: "probe", setup, getProvider })) as unknown as CreateConnectorFn;
    const config = createConfig({ chains: [mainnet], connectors: [create], transports: { [mainnet.id]: http() } });
    return { config, setup, getProvider };
  }

  it("calls a connector's setup() while it builds the config", () => {
    const { setup } = probe();
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("calls getProvider() on every connector when a page reconnects, with nothing to restore", async () => {
    const { config, getProvider } = probe();
    await reconnect(config);
    expect(getProvider).toHaveBeenCalled();
  });

  it("has WalletConnect's own setup() ask for the provider, which loads it and starts its client", async () => {
    const actual = await vi.importActual<typeof import("wagmi/connectors")>("wagmi/connectors");
    const stock = actual.walletConnect({ projectId: PROJECT_ID })({
      chains: [mainnet],
      emitter: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), once: vi.fn(), uid: "test" } as never,
      providers: [],
      transports: {},
    });
    // Asking for nothing back keeps this from loading anything: setup() only needs to be seen asking.
    const getProvider = vi.fn(async () => undefined);
    stock.getProvider = getProvider as unknown as typeof stock.getProvider;
    await stock.setup?.();
    expect(getProvider).toHaveBeenCalledTimes(1);
  });

  // lazyWalletConnect overrides connect, getProvider, disconnect, onDisconnect and isAuthorized on wagmi's connector, and reads
  // what wagmi's actions do around them. A new @wagmi/connectors can change any of that without a type error.
  it("is the @wagmi/connectors release this wrapper was checked against", async () => {
    const { version } = await vi.importActual<typeof import("wagmi/connectors")>("wagmi/connectors");
    expect(version, "re-verify lazyWalletConnect after a wagmi upgrade, then update this version").toBe("8.2.0");
  });
});
