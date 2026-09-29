import { beforeEach, describe, expect, it, vi } from "vitest";
import { connect, createConfig, createStorage, disconnect, http, reconnect } from "@wagmi/core";
import { UserRejectedRequestError } from "viem";
import { CHAINS } from "@arcos/chain";
import { connectErrorMessage } from "@/lib/network";
import { lazyWalletConnect } from "../lazyWalletConnect";

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
    const { config } = makeConfig(lastConnection("walletConnect"));
    await reconnect(config);
    expect(inner.getProvider).toHaveBeenCalled();
    expect(config.state.status).toBe("connected");
    expect(config.state.connections.size).toBe(1);
    // The session was restored, not asked for again.
    expect(provider.connect).not.toHaveBeenCalled();
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

// Why lazyWalletConnect exists. If wagmi's own connector stops doing this, the wrapper can go.
describe("wagmi's own walletConnect connector", () => {
  it("starts WalletConnect from setup(), which createConfig calls at once", async () => {
    const actual = await vi.importActual<typeof import("wagmi/connectors")>("wagmi/connectors");
    const stock = actual.walletConnect({ projectId: PROJECT_ID })({
      chains: [mainnet],
      emitter: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), once: vi.fn(), uid: "test" } as never,
      transports: {},
    });
    expect(typeof stock.setup).toBe("function");
  });
});
