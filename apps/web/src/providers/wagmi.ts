import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAINS, activeNetwork } from "@arcos/chain";

const { mainnet, testnet } = CHAINS;

// WalletConnect is dropped: its connector chain (@walletconnect/*, @reown/*)
// brings high/critical `npm audit` findings that install-time tree-shaking
// can't avoid. injected() alone discovers every EIP-6963 browser wallet.
export const wagmiConfig = createConfig({
  // The first chain is the one wallets are asked to connect on.
  chains: activeNetwork() === "mainnet" ? [mainnet, testnet] : [testnet, mainnet],
  connectors: [injected()],
  transports: { [mainnet.id]: http(), [testnet.id]: http() },
  ssr: true,
});

/**
 * The generic `injected()` connector registered above keeps its default id "injected" until wagmi
 * discovers a real wallet's EIP-6963 announcement, which adds a separate connector per wallet (id
 * e.g. "io.metamask"). With a wallet installed, the generic entry is just a second, less useful
 * button for the same wallet — once any discovered connector exists, hide it. When the only entry
 * left IS the generic one and the page has no `window.ethereum` at all, there is truly no wallet to
 * connect: return an empty list so the caller's "no wallet" state can render instead of a button
 * that always fails with wagmi's raw "Provider not found."
 */
export function visibleConnectors<C extends { id: string }>(
  connectors: readonly C[],
  hasInjectedProvider: boolean,
): C[] {
  const discovered = connectors.filter((c) => c.id !== "injected");
  if (discovered.length > 0) return discovered;
  return hasInjectedProvider ? connectors.filter((c) => c.id === "injected") : [];
}
