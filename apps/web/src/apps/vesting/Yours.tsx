"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useConnection, usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { getAddress } from "viem";
import { activeChain, activeNetwork, explorerUrl, type Address } from "@arcos/chain";
import { useDesktop } from "@arcos/shell";
import { describeContractError } from "@/lib/contract-error";
import { shortAddress } from "@/lib/format";
import { YOURS_NOTE } from "./copy";
import { Curve } from "./Curve";
import { addWallet, addedKey, readAdded, tokenCache } from "./added";
import { PAGE, checkAdded, loadVestings, type WalletView } from "./load";
import { session } from "./session";
import { spanText, utcText } from "./span";
import { useRelease } from "./useCreate";
import { VESTING_FROM_BLOCK } from "./config";
import { amountText, phaseText, releaseState } from "./view";

const INPUT = "min-w-0 rounded-md border border-border-2 bg-surface px-2 py-1.5 text-xs font-mono";
const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd title={title}>{value}</dd>
    </>
  );
}

function Wallet({ w, now, onRelease, onToken, busy }: { w: WalletView; now: bigint; onRelease: (w: WalletView) => void; onToken: (w: WalletView, token: string) => Promise<string | null>; busy: boolean }) {
  const [tokenText, setTokenText] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const state = releaseState(w, busy);
  const end = w.start + w.duration;
  return (
    <li className="rounded-md border border-border-2 p-3" data-testid="vesting-wallet">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="font-medium">{w.tokenInfo ? amountText(w.total, w.tokenInfo) : "Token unknown"}</p>
        <p className="flex flex-wrap gap-x-3 text-xs">
          <a className="text-accent-text" href={explorerUrl("address", w.wallet)} target="_blank" rel="noreferrer">
            Vesting contract {shortAddress(w.wallet)}
          </a>
          {w.token && (
            <a className="text-accent-text" href={`/t/${w.token}`} target="_blank" rel="noreferrer">
              Token proof page
            </a>
          )}
        </p>
      </div>
      <p className="mt-1 text-xs text-muted">
        {phaseText(w, now)}
        {w.source === "added" ? " Added by you." : ""}
      </p>
      <div className="mt-2 rounded-md bg-surface-2 p-2">
        <Curve start={w.start} duration={w.duration} cliff={w.cliff} now={now} label={`Release curve with now marked. ${phaseText(w, now)}`} />
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        <Row label="Starts" value={utcText(w.start)} />
        <Row label="Cliff" value={w.cliff === 0n ? "None" : `${spanText(w.cliff)} (${utcText(w.start + w.cliff)})`} />
        <Row label="Ends" value={utcText(end)} />
        <Row label="Total" value={amountText(w.total, w.tokenInfo)} />
        <Row label="Unlocked so far" value={amountText(w.vested, w.tokenInfo)} />
        <Row label="Already released" value={amountText(w.released, w.tokenInfo)} />
        <Row label="Can be released now" value={amountText(w.releasable, w.tokenInfo)} />
      </dl>
      {w.token === null && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onToken(w, tokenText).then(setTokenError);
          }}
        >
          <input aria-label="Token address of this schedule" className={`${INPUT} flex-1`} placeholder="Token address of this schedule" value={tokenText} onChange={(e) => setTokenText(e.target.value)} />
          <button type="submit" className={BUTTON}>
            Show amounts
          </button>
        </form>
      )}
      {tokenError && <p className="mt-1 text-xs text-accent-3-text">{tokenError}</p>}
      <div className="mt-3">
        <button type="button" className={`${BUTTON} w-full`} disabled={!state.enabled} onClick={() => onRelease(w)}>
          {state.label}
        </button>
        {state.reason && <p className="mt-1 text-xs text-muted">{state.reason}</p>}
      </div>
    </li>
  );
}

/** The Your schedules tab: the wallets of schedules made for the connected address, with what has unlocked and a Release button. */
export function Yours({ factory, active }: { factory: Address; active: boolean }) {
  const network = activeNetwork();
  const chain = activeChain();
  const { notify } = useDesktop();
  const { address } = useConnection();
  const client = usePublicClient({ chainId: chain.id });
  const release = useRelease();
  const run = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  const [count, setCount] = useState(PAGE);
  const key = address ? addedKey(network, address) : "";
  const [added, setAdded] = useState(() => (key ? readAdded(key) : []));
  const [syncedKey, setSyncedKey] = useState(key);
  if (key !== syncedKey) {
    setSyncedKey(key);
    setAdded(key ? readAdded(key) : []);
  }
  const [releasing, setReleasing] = useState<string | null>(null);
  const [addWalletText, setAddWalletText] = useState("");
  const [addTokenText, setAddTokenText] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["vesting-yours", network, factory, address, count, added],
    queryFn: () => loadVestings(client!, { factory, user: address!, count, fromBlock: VESTING_FROM_BLOCK[network], added, cache: tokenCache(network) }),
    enabled: active && !!client && !!address,
    refetchInterval: 20_000,
  });
  // A run that just finished may have made schedules for this address.
  const runDone = run.status === "done" ? run.startedAt : 0;
  const { refetch } = query;
  useEffect(() => {
    if (runDone) void refetch();
  }, [runDone, refetch]);

  if (!address) return null;
  const data = query.data;

  const doRelease = async (w: WalletView) => {
    if (!w.token) return;
    setReleasing(w.wallet);
    try {
      await release(w.wallet, w.token);
      notify("Released");
    } catch (err) {
      notify(describeContractError(err), "warn", 6000);
    } finally {
      setReleasing(null);
      void refetch();
    }
  };

  // A token the person types is checked against the wallet before it is kept (see tokenSource.confirmToken).
  const setToken = async (w: WalletView, token: string): Promise<string | null> => {
    if (!client) return "Wallet or network isn't ready.";
    const problem = await checkAdded(client, factory, address, w.wallet, token.trim(), VESTING_FROM_BLOCK[network]);
    if (problem) return problem;
    setAdded(addWallet(key, w.wallet, getAddress(token.trim()) as Address));
    return null;
  };

  const submitAdd = async () => {
    if (!client) return;
    setAddError(null);
    const problem = await checkAdded(client, factory, address, addWalletText.trim(), addTokenText.trim(), VESTING_FROM_BLOCK[network]);
    if (problem) return setAddError(problem);
    setAdded(addWallet(key, getAddress(addWalletText.trim()) as Address, getAddress(addTokenText.trim()) as Address));
    setAddWalletText("");
    setAddTokenText("");
  };

  return (
    <div className="p-3 text-sm">
      <p className="text-xs text-muted">{YOURS_NOTE}</p>
      {query.isPending && <p className="mt-3 text-muted">Reading your schedules…</p>}
      {query.isError && (
        <p className="mt-3 text-accent-3-text">
          {"Couldn't read your schedules. "}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && (
        <>
          {data.tokenLookupFailed && (
            <p className="mt-3 text-xs text-accent-3-text">{"Couldn't look up each schedule's token, so amounts show once you enter it below the schedule."}</p>
          )}
          {data.wallets.length === 0 && <p className="mt-3 text-muted">{data.madeCount === 0 ? "No schedule has been made for this address yet." : "No schedule here belongs to you now."}</p>}
          <ul className="mt-3 grid gap-3">
            {data.wallets.map((w) => (
              <Wallet key={w.wallet} w={w} now={data.now} busy={releasing === w.wallet} onRelease={(x) => void doRelease(x)} onToken={setToken} />
            ))}
          </ul>
          {data.transferred.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              {`${data.transferred.length} ${data.transferred.length === 1 ? "schedule was" : "schedules were"} made for you but ${data.transferred.length === 1 ? "its contract has" : "their contracts have"} another owner now, so ${data.transferred.length === 1 ? "it isn't" : "they aren't"} listed: `}
              {data.transferred.map((t, i) => (
                <span key={t}>
                  {i > 0 ? ", " : ""}
                  <a className="text-accent-text" href={explorerUrl("address", t)} target="_blank" rel="noreferrer">
                    {shortAddress(t)}
                  </a>
                </span>
              ))}
              .
            </p>
          )}
          {data.hasMore && (
            <button type="button" className={`${BUTTON} mt-3`} onClick={() => setCount((c) => c + PAGE)}>
              Show older schedules
            </button>
          )}
        </>
      )}
      <details className="mt-4 text-xs">
        <summary className="cursor-pointer text-muted">Open a vesting contract by address</summary>
        <p className="mt-2 text-muted">{"For a contract that was handed to you, or a schedule whose token isn't found above. It must be one ArcOS created and one you own, and the token must be one the contract holds or has released."}</p>
        <div className="mt-2 grid gap-2">
          <input aria-label="Vesting contract address" className={INPUT} placeholder="Vesting contract address" value={addWalletText} onChange={(e) => setAddWalletText(e.target.value)} />
          <input aria-label="Token address" className={INPUT} placeholder="Token address" value={addTokenText} onChange={(e) => setAddTokenText(e.target.value)} />
          <button type="button" className={`${BUTTON} justify-self-start`} onClick={() => void submitAdd()}>
            Open it
          </button>
          {addError && <p className="text-accent-3-text">{addError}</p>}
        </div>
      </details>
    </div>
  );
}
