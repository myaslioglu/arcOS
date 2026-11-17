"use client";

import { useState, type ReactNode } from "react";
import { isAddress } from "viem";
import { ARCOS, activeNetwork, type Address } from "@arcos/chain";
import { dropParams, useDesktop, useDropTarget, type AppProps } from "@arcos/shell";
import { AppIntro } from "@/components/AppIntro";
import { ConnectGate } from "@/components/ConnectGate";
import { AUDIT_NOTE, NOT_DEPLOYED, vestingIntro } from "./copy";
import { VestingIntroArt } from "./IntroArt";
import { vesting } from "./manifest";
import { NewSchedule } from "./NewSchedule";
import { Yours } from "./Yours";

type Tab = "new" | "yours";

function Form({ params, intro }: Pick<AppProps, "params"> & { intro: ReactNode }) {
  const factory = ARCOS[activeNetwork()]?.vestingFactory ?? null;
  const { open } = useDesktop();
  const [tab, setTab] = useState<Tab>("new");
  const { over, props: dropProps } = useDropTarget(vesting.acceptsDrop, (item) => open("vesting", dropParams(item)));

  const prefilled = isAddress(params.token ?? "", { strict: false }) ? (params.token as Address) : null;
  // A token handed to an open window brings the New schedule tab forward, once per token.
  const [syncedToken, setSyncedToken] = useState(prefilled);
  if (prefilled !== syncedToken) {
    setSyncedToken(prefilled);
    if (prefilled) setTab("new");
  }

  if (!factory) return <p className="p-5 text-sm text-muted">{NOT_DEPLOYED}</p>;

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      aria-pressed={tab === id}
      className={`rounded px-3 py-1 text-xs ${tab === id ? "bg-surface-2" : "text-muted"}`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <div className={`flex h-full flex-col text-sm ${over ? "outline outline-2 outline-accent" : ""}`} {...dropProps}>
      <div role="group" aria-label="Vesting sections" className="flex gap-1 border-b border-border p-2">
        {tabButton("new", "New schedule")}
        {tabButton("yours", "Your schedules")}
      </div>
      {/* Both stay mounted, so a half-filled form survives a look at the other tab. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="p-3 pb-0">{intro}</div>
        <section aria-label="New schedule" hidden={tab !== "new"}>
          <NewSchedule prefilledToken={prefilled} />
        </section>
        <section aria-label="Your schedules" hidden={tab !== "yours"}>
          <Yours factory={factory} active={tab === "yours"} />
        </section>
      </div>
      <p className="border-t border-border p-2 text-xs text-accent-3-text">{AUDIT_NOTE}</p>
    </div>
  );
}

/**
 * Vesting: New schedule and Your schedules, behind the wallet prompt. "What is Vesting?" (copy.ts's vestingIntro)
 * stands above both sections, and above the wallet prompt before one is connected: open the first time, hidden once
 * the visitor hides it.
 */
export default function VestingWindow({ params }: AppProps) {
  const intro = <AppIntro id="vesting" content={vestingIntro(activeNetwork())} art={<VestingIntroArt />} />;
  return (
    <ConnectGate intro={intro}>
      <Form params={params} intro={intro} />
    </ConnectGate>
  );
}
