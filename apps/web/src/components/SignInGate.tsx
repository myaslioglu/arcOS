"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useConnection, useSignMessage } from "wagmi";
import { activeChain } from "@arcos/chain";
import { fetchSession, signInWithWallet, signOut, type SessionInfo, type SignOutOutcome } from "@/lib/sign-in-client";

// Apps that need a signed-in wallet (alerts, Telegram) render inside this, and this inside <ConnectGate>, so the wallet
// is connected and on Arc by the time it asks for a signature. It lives here rather than in @arcos/shell's ui, which
// never imports wagmi (AGENTS.md).

export type SignedIn = SessionInfo & {
  /**
   * Ends every session of this wallet and returns to the sign-in prompt. When that fails, the wallet stays signed in,
   * the gate shows "Couldn't sign out. Try again." above the app, and the result says so.
   */
  signOut: () => Promise<SignOutOutcome>;
  /** Reads the session again, after something changed it (a Telegram link, say). */
  refresh: () => Promise<void>;
};

const SessionContext = createContext<SignedIn | null>(null);

/** The signed-in wallet, inside <SignInGate>. */
export function useSession(): SignedIn {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() is only available inside <SignInGate>");
  return session;
}

type State =
  | { kind: "loading" }
  | { kind: "signed-out"; error: string | null; busy: boolean }
  | { kind: "unavailable" }
  | { kind: "signed-in"; session: SessionInfo; signOutError?: string };

/** A session for another wallet than the one connected doesn't count here: the user signs in with this one. */
function stateFor(session: SessionInfo | null | "unavailable", address: string | undefined): State {
  if (session === "unavailable") return { kind: "unavailable" };
  if (session && address && session.address === address.toLowerCase()) return { kind: "signed-in", session };
  return { kind: "signed-out", error: null, busy: false };
}

const box = "grid h-full place-items-center p-6 text-center text-sm";
const button = "mt-3 rounded-lg border border-border-2 px-3 py-1.5";

export function SignInGate({ children }: { children: React.ReactNode }) {
  const { address } = useConnection();
  const signMessage = useSignMessage();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => setState(stateFor(await fetchSession(), address)), [address]);

  useEffect(() => {
    let live = true;
    void fetchSession().then((session) => {
      if (live) setState(stateFor(session, address));
    });
    return () => {
      live = false;
    };
  }, [address]);

  const signIn = async () => {
    if (!address) return;
    setState({ kind: "signed-out", error: null, busy: true });
    const outcome = await signInWithWallet({
      address,
      chainId: activeChain().id,
      signMessage: ({ message }) => signMessage.mutateAsync({ message }),
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    });
    if (outcome.ok) await load();
    else setState({ kind: "signed-out", error: outcome.error, busy: false });
  };

  if (state.kind === "loading") return <div className={box} aria-busy="true" />;
  if (state.kind === "unavailable") {
    return (
      <div className={box}>
        <p className="text-muted">Sign-in isn&apos;t available right now. Try again later.</p>
      </div>
    );
  }
  if (state.kind === "signed-out") {
    return (
      <div className={box}>
        <div>
          <p className="text-muted">Sign in to use alerts.</p>
          <p className="mt-1 text-muted">Your wallet signs a message. Signing is free and sends no transaction.</p>
          <button type="button" disabled={state.busy} className={button} onClick={() => void signIn()}>
            {state.busy ? "Check your wallet…" : "Sign in"}
          </button>
          {state.error && <p className="mt-2 text-accent-3-text">{state.error}</p>}
        </div>
      </div>
    );
  }

  const { session } = state;
  const value: SignedIn = {
    ...session,
    signOut: async () => {
      const outcome = await signOut();
      if (outcome.ok) await load();
      else setState({ kind: "signed-in", session, signOutError: outcome.error });
      return outcome;
    },
    refresh: load,
  };
  return (
    <SessionContext.Provider value={value}>
      {state.signOutError && (
        <p role="alert" className="px-3 py-1.5 text-center text-xs text-accent-3-text">
          {state.signOutError}
        </p>
      )}
      {children}
    </SessionContext.Provider>
  );
}
