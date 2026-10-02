import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAINS, activeNetwork } from "@arcos/chain";
import { lazyWalletConnect } from "./lazyWalletConnect";

const { mainnet, testnet } = CHAINS;

/** The site a build without a usable NEXT_PUBLIC_SITE_URL names: the mainnet one, as before the testnet site existed. */
const DEFAULT_SITE = "https://4rcos.com";

/**
 * How wallets show 4rc.OS when a phone pairs through WalletConnect. The url is the site's own origin, from
 * NEXT_PUBLIC_SITE_URL (https://4rcos.com on mainnet, https://testnet.4rcos.com on testnet): wallets show it, and
 * WalletConnect's verify service checks it against the page's origin. Wallets fetch the icon themselves, so it is an
 * absolute URL on the same origin, and the 180px PNG the app already serves as its home-screen icon (app/apple-icon.tsx)
 * rather than the SVG favicon.
 */
export function walletConnectMetadata(siteUrl: string | undefined) {
  let origin = DEFAULT_SITE;
  try {
    const url = new URL(siteUrl?.trim() ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") origin = url.origin;
  } catch {
    // unset or not a URL: the default
  }
  return {
    name: "4rc.OS",
    description: "Small token tools on Arc, as a desktop.",
    url: origin,
    icons: [`${origin}/apple-icon`],
  };
}

export const WALLETCONNECT_METADATA = walletConnectMetadata(process.env.NEXT_PUBLIC_SITE_URL);

// A public Reown project ID, which Next inlines where this module is built: a client identifier that ships in the browser
// bundle, not a secret. The domain allowlist in the Reown dashboard is what limits its use. Unset (or blank), WalletConnect
// is left out and the connectors are just injected().
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();

// WalletConnect is in so a phone with no browser wallet can connect Trust Wallet, MetaMask or Binance Wallet. It had been
// dropped over `npm audit`: its packages (@walletconnect/*, @reown/*) were expected to bring high or critical findings.
// `npm audit --omit=dev` on 2026-09-29 reported 0 high and 0 critical (8 low, 37 moderate overall). Those packages are
// flagged moderate only, through decode-uri-component (denial of service on malformed percent-encoded input) and uuid (a
// missing buffer bounds check).
//
// Since wagmi 3 the provider is an optional peer of wagmi's connector, so apps/web/package.json pins it itself, exactly at
// @walletconnect/ethereum-provider 2.21.8: the last release under Apache-2.0. From 2.21.9 on, @walletconnect/* and
// @reown/* ship under Reown's own community licence instead (a proprietary licence with usage thresholds), which this
// MIT repo doesn't take on. scripts/walletconnect-licence.mjs (run by the web tests) fails if the lockfile ever resolves past
// that line.
//
// The provider is a dynamic import, so it sits in a chunk of its own, and lazyWalletConnect keeps wagmi from loading it
// until a visitor picks WalletConnect (or a reload restores a WalletConnect session). injected() alone still discovers
// every EIP-6963 browser wallet.
export const wagmiConfig = createConfig({
  // The first chain is the one wallets are asked to connect on.
  chains: activeNetwork() === "mainnet" ? [mainnet, testnet] : [testnet, mainnet],
  connectors: [
    injected(),
    ...(walletConnectProjectId
      ? [lazyWalletConnect({ projectId: walletConnectProjectId, showQrModal: true, metadata: WALLETCONNECT_METADATA })]
      : []),
  ],
  transports: { [mainnet.id]: http(), [testnet.id]: http() },
  ssr: true,
  // CCIP-Read off for every client this config builds. The Inspector (and Drop, for a token pasted in) reads contracts
  // anyone can deploy, and with it on, a read that reverts with EIP-3668's OffchainLookup makes the visitor's browser
  // fetch URLs the contract chose. Such a revert is read like any other.
  ccipRead: false,
});

const WALLETCONNECT_ID = "walletConnect";

/**
 * Which connectors the Wallet window offers, in order.
 *
 * The generic `injected()` connector registered above keeps its default id "injected" until wagmi discovers a real wallet's
 * EIP-6963 announcement, which adds a separate connector per wallet (id e.g. "io.metamask"). With a wallet installed, the
 * generic entry is just a second, less useful button for the same wallet, so once any such wallet is discovered, hide it.
 * When none was, the generic entry stays if the page has a `window.ethereum` (a wallet's own in-app browser injects one
 * without announcing it) and goes if it doesn't: a button that always fails with wagmi's raw "Provider not found." is worse
 * than none.
 *
 * WalletConnect, when it is configured, is not a discovered wallet: it never hides the generic entry, and it always comes
 * last. On a phone with no wallet in the browser it is the only entry. With nothing to offer at all the list is empty, so
 * the caller's "no wallet" state can render.
 */
export function visibleConnectors<C extends { id: string }>(
  connectors: readonly C[],
  hasInjectedProvider: boolean,
): C[] {
  const discovered = connectors.filter((c) => c.id !== "injected" && c.id !== WALLETCONNECT_ID);
  const browserWallets =
    discovered.length > 0 ? discovered : hasInjectedProvider ? connectors.filter((c) => c.id === "injected") : [];
  return [...browserWallets, ...connectors.filter((c) => c.id === WALLETCONNECT_ID)];
}

/**
 * What a connect button says. Wallets name themselves; "WalletConnect" alone doesn't tell someone on a phone what it is for.
 */
export function connectorLabel(connector: { id: string; name: string }): string {
  return connector.id === WALLETCONNECT_ID ? "WalletConnect (phone wallets)" : connector.name;
}

/**
 * Whether a connector is WalletConnect's, the one connector that opens a modal of its own. Takes what
 * `useConnect().variables.connector` holds: a connector, or a connector factory, which wagmi's connect also accepts and
 * which can't be told by id.
 */
export function isWalletConnect(connector: unknown): boolean {
  return typeof connector === "object" && connector !== null && (connector as { id?: unknown }).id === WALLETCONNECT_ID;
}
