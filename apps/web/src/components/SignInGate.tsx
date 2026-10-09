"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
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

/**
 * How long a read of the session may take. One that hangs (the phone changed networks) would otherwise hold the gate
 * in whatever view it has, the last wallet's app included, for as long as the browser waits; a read that gave up
 * answers "unavailable" (fetchSession catches the rejection), and the gate says so.
 */
const SESSION_READ_MS = 10_000;
const readSession = () => fetchSession((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(SESSION_READ_MS) }));

const box = "grid h-full place-items-center p-6 text-center text-sm";
const button = "mt-3 rounded-lg border border-border-2 px-3 py-1.5";

export function SignInGate({ children }: { children: React.ReactNode }) {
  const { address } = useConnection();
  const signMessage = useSignMessage();
  const [state, setState] = useState<State>({ kind: "loading" });

  // The state is the connected wallet's. When the account changes in the wallet, the last wallet's session leaves the
  // page at once, with the app under it (its list, its buttons), as a state adjusted during the render: the re-read
  // below answers for the new wallet, and until it does the gate shows its loading view, not the last wallet's app
  // under the new wallet's address.
  const [seenAddress, setSeenAddress] = useState(address);
  if (address !== seenAddress) {
    setSeenAddress(address);
    setState({ kind: "loading" });
  }

  // The address the gate is reading for. A read that answers after the account changed (the effect's, or load()'s
  // after a sign-in, a sign-out or an app's refresh) is the last wallet's: it sets nothing, so the last wallet's
  // session can't come back over the loading view, or over the new wallet's answer.
  const readingFor = useRef(address);

  const load = useCallback(async () => {
    const session = await readSession();
    if (readingFor.current === address) setState(stateFor(session, address));
  }, [address]);

  useEffect(() => {
    readingFor.current = address;
    let live = true;
    void readSession().then((session) => {
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
    else if (readingFor.current === address) setState({ kind: "signed-out", error: outcome.error, busy: false });
  };

  // A read that failed, or gave up (a slow connection: the 10 s above): Retry reads again, the loading view meanwhile.
  // Nothing else re-reads for this view, so without it the window would have to be opened again.
  const retry = () => {
    setState({ kind: "loading" });
    void load();
  };

  if (state.kind === "loading") return <div className={box} aria-busy="true" />;
  if (state.kind === "unavailable") {
    return (
      <div className={box}>
        <div>
          <p className="text-muted">Sign-in isn&apos;t available right now. Try again later.</p>
          <button type="button" className={button} onClick={retry}>
            Retry
          </button>
        </div>
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
      else if (readingFor.current === address) setState({ kind: "signed-in", session, signOutError: outcome.error });
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
