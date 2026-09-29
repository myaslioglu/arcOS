import { walletConnect, type WalletConnectParameters } from "wagmi/connectors";

/**
 * wagmi's WalletConnect connector, held back until it is wanted.
 *
 * wagmi runs a connector's `setup()` while it builds the config, on the server too, and calls `getProvider()` on every
 * connector each time a page reconnects. WalletConnect's own connector answers both by loading its provider and starting
 * its client, which asks Reown's servers for the project's configuration. That would happen for every visitor on every
 * page load, whether or not they ever use WalletConnect, and again while the server renders and builds.
 *
 * This one starts none of it until
 * - the visitor picks WalletConnect (`connect()`), or
 * - the browser's last connection was through WalletConnect, so a reload restores that session.
 *
 * Everything else is wagmi's connector as it ships. The rest of the app only ever sees a connector with the id
 * "walletConnect".
 */
export function lazyWalletConnect(parameters: WalletConnectParameters): ReturnType<typeof walletConnect> {
  const create = walletConnect(parameters);

  return (config) => {
    const connector = create(config);
    const { connect, disconnect, getProvider } = connector;
    let picked = false;

    // wagmi calls this while it builds the config. The stock one starts WalletConnect there.
    connector.setup = undefined;

    connector.connect = function (this: unknown, ...args: Parameters<typeof connect>) {
      picked = true;
      return connect.apply(this, args);
    } as typeof connect;

    const wasLastConnection = async () => (await config.storage?.getItem("recentConnectorId")) === connector.id;

    connector.getProvider = async function (this: unknown, ...args: Parameters<typeof getProvider>) {
      // `undefined` is what wagmi's reconnect reads as "nothing to restore here", and it moves on to the next connector.
      if (!picked && !(await wasLastConnection())) return undefined;
      return getProvider.apply(this, args);
    } as typeof getProvider;

    connector.disconnect = async function (this: unknown) {
      await disconnect.call(this);
      // wagmi keeps `recentConnectorId` after the last disconnect. Left there, it would load WalletConnect on every reload
      // from now on, for a session that no longer exists. Best effort: the disconnect itself has already happened.
      try {
        if (await wasLastConnection()) await config.storage?.removeItem("recentConnectorId");
      } catch {
        // Storage that can't be read or written has nothing to clean up either.
      }
    };

    return connector;
  };
}
