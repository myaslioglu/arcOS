import { walletConnect, type WalletConnectParameters } from "wagmi/connectors";

/**
 * Raised by a WalletConnect `connect()` when the provider itself could not be loaded or started, as when its chunk 404s
 * after a deploy or the connection drops. wagmi's connector keeps a load that failed, so every later click fails again until
 * the page is reloaded. Matched by name in `lib/network.ts`, which words it for the Wallet window.
 */
export class WalletConnectLoadError extends Error {
  constructor(cause: unknown) {
    super("WalletConnect could not be loaded.", { cause });
    this.name = "WalletConnectLoadError";
  }
}

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
 * wagmi writes the record of the last connection (`recentConnectorId`) and never clears it, so this connector forgets it
 * itself when a session ends: when the app disconnects, when the wallet ends the session while the page is open, and when a
 * reload finds nothing to restore because the session expired or was ended while the tab was closed. An ended session
 * therefore costs at most one more load.
 *
 * Everything else is wagmi's connector as it ships. The rest of the app only ever sees a connector with the id
 * "walletConnect".
 */
export function lazyWalletConnect(parameters: WalletConnectParameters): ReturnType<typeof walletConnect> {
  const create = walletConnect(parameters);

  return (config) => {
    const connector = create(config);
    const { connect, disconnect, getProvider, isAuthorized, onDisconnect } = connector;
    let picked = false;

    // wagmi calls this while it builds the config. The stock one starts WalletConnect there.
    connector.setup = undefined;

    connector.connect = async function (this: unknown, ...args: Parameters<typeof connect>) {
      picked = true;
      // wagmi's own connect() asks for the provider first thing. Doing it here first tells a load that fails apart from a wallet
      // that refuses: only the first is cured by a reload.
      try {
        await getProvider.call(this);
      } catch (error) {
        throw new WalletConnectLoadError(error);
      }
      return connect.apply(this, args);
    } as typeof connect;

    const wasLastConnection = async () => (await config.storage?.getItem("recentConnectorId")) === connector.id;

    connector.getProvider = async function (this: unknown, ...args: Parameters<typeof getProvider>) {
      // `undefined` is what wagmi's reconnect reads as "nothing to restore here", and it moves on to the next connector.
      if (!picked && !(await wasLastConnection())) return undefined;
      return getProvider.apply(this, args);
    } as typeof getProvider;

    // Best effort, and only WalletConnect's own record: whatever ended, it has already happened.
    const forget = async () => {
      try {
        if (await wasLastConnection()) await config.storage?.removeItem("recentConnectorId");
      } catch {
        // Storage that can't be read or written has nothing to clean up either.
      }
    };

    connector.disconnect = async function (this: unknown) {
      await disconnect.call(this);
      await forget();
    };

    // The wallet ended the session while the page was open (the provider's session_delete or disconnect, or no accounts left).
    // The record goes even when wagmi's own handler fails, which still fails as it did: the session has ended either way.
    connector.onDisconnect = async function (this: unknown, ...args: Parameters<typeof onDisconnect>) {
      try {
        await onDisconnect.apply(this, args);
      } finally {
        await forget();
      }
    } as typeof onDisconnect;

    // wagmi asks this to reconnect after a reload, so false means there was nothing to restore.
    connector.isAuthorized = async function (this: unknown) {
      const authorized = await isAuthorized.call(this);
      if (!authorized) await forget();
      return authorized;
    };

    return connector;
  };
}
