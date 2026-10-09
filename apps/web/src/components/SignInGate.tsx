"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
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

  // Every read of the session below (the effect's, and load()'s after a sign-in, a sign-out, Retry or an app's
  // refresh) acts only for the gate as it was when the read began: the same wallet, and no later read. `turn` counts
  // the moves: the account changing (the layout effect, in the commit itself, so no answer can land between the
  // change and the count), the gate leaving the page, and every read begun. A read checks the count right after its
  // await (`movedOn`) and sets nothing when it has moved: an answer for the last wallet can't come back over the
  // loading view or over the new wallet's answer, and an older read of the same wallet can't overwrite a newer one,
  // whichever answers first. Without the count, two reads could be out at once (the Watchdog window's link poll asks
  // for a refresh every 5 s until the gate has answered, and a read may take 10 s), and the older one, landing last,
  // put back what the newer one had corrected: "Telegram linked." with Unlink after an unlink that succeeded, the app
  // under a cleared cookie after a read that said signed out, or the "unavailable" view over Retry's loading view.
  // `wallet` is the connected address as of the same commit: a read that is still the latest is for it.
  const turn = useRef(0);
  const wallet = useRef(address);
  const movedOn = (mine: number) => mine !== turn.current;
  useLayoutEffect(() => {
    turn.current += 1;
    wallet.current = address;
    return () => {
      turn.current += 1;
    };
  }, [address]);

  const load = useCallback(async () => {
    const mine = ++turn.current;
    const session = await readSession();
    if (movedOn(mine)) return;
    setState(stateFor(session, wallet.current));
  }, []);

  useEffect(() => {
    void load();
  }, [address, load]);

  // A sign-in that succeeded always reads again: the read is the latest, for the wallet connected now (the session it
  // made shows that wallet its app, another wallet its prompt), and it covers the account changing and changing back
  // while the wallet signed, when the new wallet's read may have landed before the sign-in's cookie existed. A failed
  // one sets its sentence only on the prompt it was pressed from: when the account changed meanwhile, that prompt has
  // left the page with the loading view. The count is read, not moved: a sign-in is no read.
  const signIn = async () => {
    if (!address) return;
    const mine = turn.current;
    setState({ kind: "signed-out", error: null, busy: true });
    const outcome = await signInWithWallet({
      address,
      chainId: activeChain().id,
      signMessage: ({ message }) => signMessage.mutateAsync({ message }),
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    });
    if (outcome.ok) {
      await load();
      return;
    }
    if (movedOn(mine)) return;
    setState({ kind: "signed-out", error: outcome.error, busy: false });
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
          <p className="text-muted">Sign-in isn&apos;t available right now.</p>
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
    // A sign-out that succeeded ended the cookie, whoever is connected now: the session is read again, and that read
    // is the latest (above). One that failed adds its sentence to the signed-in view of the wallet that pressed it, as
    // the gate holds that view now, not as it was at the press: a read that landed meanwhile (an app's refresh, with
    // the Telegram chat linked) stands, and when the view is another wallet's, or the sign-in prompt, there is
    // nothing to add it to.
    signOut: async () => {
      const outcome = await signOut();
      if (outcome.ok) await load();
      else setState((s) => (s.kind === "signed-in" && s.session.address === session.address ? { ...s, signOutError: outcome.error } : s));
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
