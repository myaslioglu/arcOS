"use client";

import { useId, useMemo, useRef } from "react";
import { CircleDollarSign, Eye, FlaskConical, KeyRound, Network, Plug, ScanSearch, Trash2, Wallet, type LucideIcon } from "lucide-react";
import { activeChain, activeNetwork, type NetworkId } from "@arcos/chain";
import { CATEGORY_HUE, appHue } from "@arcos/shell/core";
import { useDesktop, useRegistry } from "@arcos/shell";
import { DesktopArt, IconTile } from "./Art";
import {
  APPS_LEAD,
  FOOTER,
  GLOSSARY,
  NOT_ADVICE,
  SECTIONS,
  WHAT_IS,
  startSteps,
  tips,
  type SectionId,
  type StartStep,
  type Tip,
} from "./copy";
import { guideGroups, type GuideCard } from "./guide";

const STEP_ART: Record<StartStep["key"], { icon: LucideIcon; hue: string }> = {
  wallet: { icon: Wallet, hue: "var(--accent)" },
  network: { icon: Network, hue: "var(--accent-2)" },
  usdc: { icon: CircleDollarSign, hue: "var(--accent-3)" },
  connect: { icon: Plug, hue: "var(--accent)" },
};

const TIP_ICON: Record<Tip["key"], LucideIcon> = {
  phrase: KeyRound,
  read: Eye,
  inspect: ScanSearch,
  revoke: Trash2,
  testnet: FlaskConical,
};

const H2 = "scroll-mt-2 text-base font-semibold outline-none";
const BUTTON = "min-h-8 shrink-0 rounded-md border border-border-2 bg-surface px-3 text-xs pointer-coarse:min-h-11";
const LINK = "text-accent-text underline underline-offset-2";

/**
 * Help: a short guide to ArcOS, readable in a minute. A row of jump links over five sections: what ArcOS is, getting
 * started in four steps, a card for each app this site lists (from the registry, so it matches the desktop and the
 * network), how to protect your wallet, and a few words explained. Opens apps with the desktop's own `open`.
 */
export default function HelpWindow() {
  const { list } = useRegistry();
  const { open } = useDesktop();
  const network = activeNetwork();
  const groups = useMemo(() => guideGroups(list, network), [list, network]);
  return <HelpGuide groups={groups} network={network} chainName={activeChain().name} onOpen={(id) => open(id)} />;
}

type GuideProps = {
  groups: ReturnType<typeof guideGroups>;
  network: NetworkId;
  chainName: string;
  onOpen: (appId: string) => void;
};

/** The guide as its props draw it, so a test can render it for either network without a desktop around it. */
export function HelpGuide({ groups, network, chainName, onOpen }: GuideProps) {
  const uid = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const idOf = (id: SectionId) => `${uid}-${id}`;
  const heading = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.heading;
  // A jump scrolls the guide to the section and moves focus to its heading, so the keyboard and a screen reader go
  // there too. Only the guide's own scroller moves: scrollIntoView would scroll the window's frame as well, and push
  // the jump links out of sight. Buttons, not "#" links: a hash in the address would reach the desktop's deep links.
  const jump = (id: SectionId) => {
    const el = document.getElementById(idOf(id));
    const box = scroller.current;
    if (!el || !box) return;
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
    el.focus({ preventScroll: true });
  };
  const steps = startSteps(network, chainName);

  return (
    <div className="@container flex h-full flex-col text-sm">
      {/* One row: on a phone it scrolls sideways on its own rather than taking two rows of the screen. */}
      <nav aria-label="Help sections" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border pb-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="min-h-7 shrink-0 rounded-full border border-border-2 px-3 text-xs whitespace-nowrap text-muted hover:text-fg pointer-coarse:min-h-11"
            onClick={() => jump(s.id)}
          >
            {s.jump}
          </button>
        ))}
      </nav>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto pt-4" data-help-scroll>
        <section aria-labelledby={idOf("what")} className="grid items-center gap-4 @min-[460px]:grid-cols-[1fr_200px]">
          <div className="grid gap-2">
            <h2 id={idOf("what")} tabIndex={-1} className={H2}>
              {heading("what")}
            </h2>
            {WHAT_IS.map((line) => (
              <p key={line} className="leading-6">
                {line}
              </p>
            ))}
          </div>
          <div className="mx-auto w-full max-w-[200px]">
            <DesktopArt />
          </div>
        </section>

        <section aria-labelledby={idOf("start")} className="mt-8 grid gap-3">
          <h2 id={idOf("start")} tabIndex={-1} className={H2}>
            {heading("start")}
          </h2>
          <ol className="grid gap-3 @min-[460px]:grid-cols-2">
            {steps.map((step, i) => (
              <li key={step.key} className="flex gap-3 rounded-lg border border-border bg-surface-2 p-3">
                <IconTile icon={STEP_ART[step.key].icon} hue={STEP_ART[step.key].hue} step={i + 1} />
                <div className="grid min-w-0 content-start gap-1">
                  <h3 className="text-sm font-medium">
                    <span className="sr-only">{`Step ${i + 1}: `}</span>
                    {step.title}
                  </h3>
                  <p className="text-xs leading-5 text-muted">{step.text}</p>
                  {step.link && (
                    <a className={`text-xs ${LINK}`} href={step.link.href} target="_blank" rel="noopener noreferrer">
                      {step.link.label}
                    </a>
                  )}
                  {step.app && (
                    <button type="button" className={`${BUTTON} mt-1 justify-self-start`} onClick={() => onOpen(step.app!.id)}>
                      {step.app.label}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby={idOf("apps")} className="mt-8 grid gap-3">
          <h2 id={idOf("apps")} tabIndex={-1} className={H2}>
            {heading("apps")}
          </h2>
          <p className="text-muted">{APPS_LEAD}</p>
          {groups.map((g) => (
            <div key={g.category} className="grid gap-2" data-group={g.category}>
              <h3 className="flex items-center gap-2 font-mono text-xs text-muted uppercase tracking-wider">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: CATEGORY_HUE[g.category] }} />
                {`${g.label} folder`}
              </h3>
              <ul className="grid gap-2 @min-[460px]:grid-cols-2">
                {g.cards.map((card) => (
                  <AppCard key={card.app.id} card={card} onOpen={onOpen} />
                ))}
              </ul>
            </div>
          ))}
          <p className="text-xs text-faint">{NOT_ADVICE}</p>
        </section>

        <section aria-labelledby={idOf("protect")} className="mt-8 grid gap-3">
          <h2 id={idOf("protect")} tabIndex={-1} className={H2}>
            {heading("protect")}
          </h2>
          <ul className="grid gap-2">
            {tips(network).map((tip) => (
              <li key={tip.key} className="flex items-center gap-3">
                <IconTile icon={TIP_ICON[tip.key]} hue={tip.key === "phrase" ? "var(--danger)" : "var(--accent-2)"} small />
                <span className="leading-5">{tip.text}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby={idOf("words")} className="mt-8 grid gap-3">
          <h2 id={idOf("words")} tabIndex={-1} className={H2}>
            {heading("words")}
          </h2>
          <dl className="grid gap-x-4 gap-y-2 @min-[460px]:grid-cols-2">
            {GLOSSARY.map(({ term, meaning }) => (
              <div key={term} className="rounded-md border border-border p-2">
                <dt className="font-mono text-xs font-medium text-accent-text">{term}</dt>
                <dd className="mt-0.5 text-xs leading-5 text-muted">{meaning}</dd>
              </div>
            ))}
          </dl>
        </section>

        <p className="mt-8 border-t border-border pt-3 pb-1 text-xs text-faint">{FOOTER}</p>
      </div>
    </div>
  );
}

/** One app: its tile, name and stage or note, what it does and when to use it, and a button that opens it. */
function AppCard({ card, onOpen }: { card: GuideCard; onOpen: (appId: string) => void }) {
  const { app, what, when, stage, note } = card;
  const coming = stage !== null;
  return (
    <li
      className="flex gap-3 rounded-lg border border-border p-3"
      data-app={app.id}
      data-coming={coming || undefined}
      style={{ "--os-hue": appHue(app) } as React.CSSProperties}
    >
      <span className={`os-icon-tile os-icon-tile--sm ${coming ? "opacity-60" : ""}`} aria-hidden>
        <app.icon size={17} />
      </span>
      <div className="grid min-w-0 flex-1 content-start gap-1">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="font-mono text-[13px] font-medium">{app.name}</h4>
            {coming && (
              <span className="rounded-full bg-accent-3/15 px-2 py-0.5 text-[11px] text-accent-3-text">{`Soon: ${stage.toLowerCase()}`}</span>
            )}
            {note && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{note}</span>}
          </div>
          <button type="button" className={`${BUTTON} -mt-0.5`} onClick={() => onOpen(app.id)}>
            {coming ? "Read more" : "Open"}
            <span className="sr-only">{coming ? ` about ${app.name}` : ` ${app.name}`}</span>
          </button>
        </div>
        <p className="text-xs leading-5">{what}</p>
        {when && <p className="text-xs leading-5 text-muted">{when}</p>}
      </div>
    </li>
  );
}
