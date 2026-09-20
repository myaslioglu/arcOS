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
