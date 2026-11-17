"use client";

import { useConnection } from "wagmi";
import { useDesktop } from "@arcos/shell";
import { useArcNetwork } from "@/lib/network";

/**
 * Apps that sign transactions render inside this: it asks for a wallet, and for Arc.
 *
 * `intro` stands above either ask, in a column that scrolls: an app's first-run explainer (components/AppIntro.tsx),
 * so a visitor learns what the app is for before connecting anything.
 *
 * `anyNetwork` drops the second ask. Bridge sets it: Circle's App Kit switches the wallet itself, to the source chain
 * for the approval and the burn and to the destination chain for the mint, so while a bridge runs the wallet is on
 * another network by design, and after one it stays there. Gating on Arc would unmount the window in the middle of
 * every bridge that touches another chain, and hide its result behind "Switch to Arc" when it is done.
 */
export function ConnectGate({
  children,
  anyNetwork = false,
  intro,
}: {
  children: React.ReactNode;
  anyNetwork?: boolean;
  intro?: React.ReactNode;
}) {
  const { isConnected } = useConnection();
  const { chain, wrongNetwork, switching, switchError, switchToArc } = useArcNetwork();
  const { open } = useDesktop();

  // With an intro, the ask stands under it and never scrolls away: a long intro scrolls in its own space above the
  // ask, and a short one (hidden by the visitor) leaves the ask centred in the rest of the window.
  const gate = (ask: React.ReactNode) =>
    intro ? (
      <div className="flex h-full flex-col text-sm">
        <div className="min-h-0 overflow-auto p-4">{intro}</div>
        <div className="grid shrink-0 grow place-items-center border-t border-border px-4 py-3 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 [&>*]:m-0">{ask}</div>
        </div>
      </div>
    ) : (
      <div className="grid h-full place-items-center p-6 text-center text-sm">
        <div>{ask}</div>
      </div>
    );

  if (!isConnected) {
    return gate(
      <>
        <p className="text-muted">Connect a wallet to use this app.</p>
        <button type="button" className="mt-3 rounded-lg border border-border-2 px-3 py-1.5" onClick={() => open("wallet")}>
          Open Wallet
        </button>
      </>,
    );
  }
  if (wrongNetwork && !anyNetwork) {
    return gate(
      <>
        <p className="text-muted">Your wallet is on another network.</p>
        <button
          type="button"
          disabled={switching}
          className="mt-3 rounded-lg border border-border-2 px-3 py-1.5"
          onClick={switchToArc}
        >
          Switch to {chain.name}
        </button>
        {switchError && <p className="mt-2 text-accent-3-text">{switchError}</p>}
      </>,
    );
  }
  return <>{children}</>;
}
