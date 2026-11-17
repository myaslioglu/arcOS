"use client";

import { useState, type ReactNode } from "react";
import { useConnection } from "wagmi";
import type { Address } from "viem";
import { activeNetwork } from "@arcos/chain";
import { useDropTarget, type AppProps } from "@arcos/shell";
import { AppIntro } from "@/components/AppIntro";
import { ConnectGate } from "@/components/ConnectGate";
import { vaultFactoryOf } from "@/lib/vault-factory";
import { UNAUDITED, vaultIntro } from "./copy";
import { VaultIntroArt } from "./IntroArt";
import { LockList } from "./LockList";
import { vault as manifest } from "./manifest";
import { NewLock, type Prefill } from "./NewLock";
import { targetFromDrop, targetFromParams, type Target } from "./target";

type Tab = "new" | "locks";

/** Params objects already shown: one is shown once per page, not again when the window remounts under the gate. */
const shown = new WeakSet<object>();

/**
 * The vaults opened by a drop or by params, per wallet, for this page: kept outside the component, since the window
 * unmounts when minimized, closed or covered on a phone, and a vault opened by its address would otherwise drop out
 * of the list.
 */
const openedByWallet = new Map<string, Address[]>();

/**
 * Vault: New lock (NewLock.tsx) and Your locks (LockList.tsx), two sections kept mounted so that a form half filled in
 * survives a look at the other. A token or a position dropped on the window, or named by its params, opens New lock
 * with it; a lock opens Your locks with that vault listed. Everything is read on chain before anything is offered.
 * "What is Vault?" (copy.ts's vaultIntro) stands above both sections, and above the wallet prompt before one is
 * connected: open the first time, hidden once the visitor hides it.
 */
export default function VaultWindow({ params }: AppProps) {
  const { address } = useConnection();
  const factory = vaultFactoryOf();
  if (!factory) return <p className="p-5 text-sm text-muted">{"Vault isn't on this network yet."}</p>;
  const intro = <AppIntro id="vault" content={vaultIntro(activeNetwork())} art={<VaultIntroArt />} />;
  return (
    <ConnectGate intro={intro}>
      <Vault key={address} factory={factory} params={params} intro={intro} />
    </ConnectGate>
  );
}

function Vault({ factory, params, intro }: { factory: Address; params: Record<string, string>; intro: ReactNode }) {
  const { address } = useConnection();
  const [tab, setTab] = useState<Tab>("new");
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const walletKey = (address ?? "").toLowerCase();
  const [opened, setOpened] = useState<Address[]>(() => openedByWallet.get(walletKey) ?? []);

  const show = (target: Target | null) => {
    if (!target) return;
    if (target.kind === "vault") {
      setOpened((list) => {
        if (list.some((a) => a.toLowerCase() === target.vault.toLowerCase())) return list;
        const next = [...list, target.vault];
        openedByWallet.set(walletKey, next);
        return next;
      });
      setTab("locks");
      return;
    }
    setPrefill((p) => ({ target, seq: (p?.seq ?? 0) + 1 }));
    setTab("new");
  };

  // The params of each open fill the window once: a state adjusted during the render (the shell keeps one params
  // object per open, so the same one isn't shown twice).
  const [seenParams, setSeenParams] = useState<Record<string, string> | null>(null);
  if (params !== seenParams) {
    setSeenParams(params);
    if (!shown.has(params)) {
      shown.add(params);
      show(targetFromParams(params));
    }
  }

  const { over, props: dropProps } = useDropTarget(manifest.acceptsDrop, (item) => show(targetFromDrop(item)));
  if (!address) return null;

  // Two toggle buttons in a labelled group, as Vesting's sections are: each is a plain button in the tab order, and
  // aria-pressed says which section shows.
  const sectionButton = (id: Tab, label: string) => (
    <button
      type="button"
      aria-pressed={tab === id}
      className={`min-h-8 rounded-md px-3 text-xs pointer-coarse:min-h-11 ${tab === id ? "bg-surface-2 font-medium" : "text-muted"}`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <div className={`flex h-full flex-col text-sm ${over ? "outline outline-2 outline-accent" : ""}`} {...dropProps}>
      <div role="group" aria-label="Vault sections" className="flex gap-1 border-b border-border px-3 py-2">
        {sectionButton("new", "New lock")}
        {sectionButton("locks", "Your locks")}
      </div>
      {/* Both stay mounted, so a half-filled form survives a look at the other section. */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-4">{intro}</div>
        <section aria-label="New lock" hidden={tab !== "new"}>
          <NewLock factory={factory} wallet={address} prefill={prefill} onShowLocks={() => setTab("locks")} />
        </section>
        <section aria-label="Your locks" hidden={tab !== "locks"}>
          <LockList factory={factory} wallet={address} opened={opened} onOpen={(vault) => show({ kind: "vault", vault })} />
        </section>
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-accent-3-text">{UNAUDITED}</p>
    </div>
  );
}
