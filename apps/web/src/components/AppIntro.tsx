"use client";

import { useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, CircleQuestionMark } from "lucide-react";
import { introOpen, setIntroOpen, subscribeIntro, type IntroContent } from "@/lib/intro";

type ViewProps = {
  id: string;
  content: IntroContent;
  /** A small picture beside the lead. Decorative: the words carry the meaning. */
  art: ReactNode;
  open: boolean;
  onToggle: () => void;
  onHide: () => void;
  /** Gets the toggle button, so focus can return to it when the panel is hidden from inside. */
  toggleRef?: React.Ref<HTMLButtonElement>;
};

const LIST_HEAD = "text-xs font-medium text-fg";

/**
 * The explainer as its props draw it, so a test can render either state: a heading whose button opens and hides the
 * panel (aria-expanded, aria-controls), and the panel itself, which stays in the page while hidden.
 */
export function AppIntroView({ id, content, art, open, onToggle, onHide, toggleRef }: ViewProps) {
  const uid = useId();
  const headId = `${uid}-head`;
  const bodyId = `${uid}-body`;
  return (
    <section aria-labelledby={headId} data-intro={id} className="rounded-lg border border-border bg-surface-2 text-sm">
      <h2 id={headId} className="m-0 text-sm font-medium">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-2 text-left pointer-coarse:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <CircleQuestionMark size={16} aria-hidden className="shrink-0 text-accent-2-text" />
          <span className="min-w-0 flex-1">{content.title}</span>
          <span aria-hidden className="text-xs font-normal text-muted">
            {open ? "Hide" : "Show"}
          </span>
          <ChevronDown size={14} aria-hidden className={`shrink-0 text-muted ${open ? "rotate-180" : ""}`} />
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="grid gap-3 px-3 pt-1 pb-3">
        {/* The picture floats, so on a narrow window the lead wraps under it rather than down a thin column beside it. */}
        <div className="flow-root">
          <div className="float-left mr-3 mb-1 w-16 text-accent-2 sm:w-20" aria-hidden>
            {art}
          </div>
          <p className="leading-6">{content.lead}</p>
        </div>
        <div className="grid gap-1">
          <h3 className={LIST_HEAD}>Who it&apos;s for</h3>
          <ul className="grid list-disc gap-1 pl-4 text-xs leading-5 text-muted">
            {content.uses.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="grid gap-1.5">
          <h3 className={LIST_HEAD}>How it works</h3>
          <ol className="grid gap-1.5 rounded-md border border-border bg-surface p-2">
            {content.steps.map((line, i) => (
              <li key={line} className="flex items-start gap-2 text-xs leading-5">
                <span
                  aria-hidden
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-2/15 font-mono text-[11px] font-medium text-accent-2-text"
                >
                  {i + 1}
                </span>
                <span>
                  <span className="sr-only">{`Step ${i + 1}: `}</span>
                  {line}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="grid gap-1">
          <h3 className={LIST_HEAD}>Good to know</h3>
          <ul className="grid list-disc gap-1 pl-4 text-xs leading-5 text-muted">
            {content.limits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={onHide}
          className="min-h-8 justify-self-start rounded-md border border-border-2 bg-surface px-3 text-xs pointer-coarse:min-h-11"
        >
          Got it, hide this
        </button>
      </div>
    </section>
  );
}

const shown = () => true;

/**
 * An app's first-run explainer: open the first time, and hidden from then on once the visitor hides it (lib/intro.ts
 * keeps the choice per browser). The heading's button opens it again at any time.
 */
export function AppIntro({ id, content, art }: { id: string; content: IntroContent; art: ReactNode }) {
  const open = useSyncExternalStore(subscribeIntro, () => introOpen(id), shown);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <AppIntroView
      id={id}
      content={content}
      art={art}
      open={open}
      toggleRef={toggle}
      onToggle={() => setIntroOpen(id, !open)}
      onHide={() => {
        setIntroOpen(id, false);
        // The button pressed goes with the panel: focus moves to the heading's button, not to the page.
        toggle.current?.focus();
      }}
    />
  );
}
