"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, CornerDownLeft } from "lucide-react";
import { searchLauncher, type LauncherHit, type QuickAction } from "../core";
import { useRegistry } from "./registry";
import { Portal } from "./Portal";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Extra rows computed from the query, e.g. "Inspect 0x…". */
  quickActions?: (query: string) => QuickAction[];
  onPickApp: (appId: string) => void;
  onPickAction: (action: QuickAction) => void;
};

/**
 * Full-screen search over the app registry, plus whatever quick actions the
 * caller derives from the query. An app row opens as a desktop window; an
 * action row hands its params straight to `onPickAction`.
 */
export function Launcher({ open, onClose, quickActions, onPickApp, onPickAction }: Props) {
  const { list } = useRegistry();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const results = useMemo(
    () => searchLauncher(list, query, quickActions?.(query) ?? []),
    [list, query, quickActions],
  );
  const selected = Math.min(cursor, Math.max(results.length - 1, 0));

  const activate = (hit: LauncherHit) => {
    if (hit.kind === "app") onPickApp(hit.app.id);
    else onPickAction(hit.action);
    setQuery("");
    setCursor(0);
    onClose();
  };

  // Escape dismisses the launcher over whatever window sits behind it. Capture phase plus
  // stopPropagation, same as MenuBar and ContextMenu: it runs before WindowFrame's own (bubble
  // phase) document listener ever sees the key, so dismissing the launcher never also closes the
  // window underneath — losing, say, a half-typed Drop list.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="os-launcher-veil"
            onClick={onClose}
          >
            <motion.div
              initial={{ y: 16, scale: 0.99, opacity: 0 }}
              animate={{ y: 0, scale: 1, opacity: 1 }}
              exit={{ y: 8, scale: 0.99, opacity: 0 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              role="dialog"
              aria-label="Search"
              className="os-launcher"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="os-launcher-input">
                <Search className="h-4 w-4 shrink-0 text-faint" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursor(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setCursor((c) => Math.min(c + 1, results.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setCursor((c) => Math.max(c - 1, 0));
                    } else if (e.key === "Enter" && results[selected]) {
                      activate(results[selected]);
                    }
                    // Escape is handled by the capture-phase document listener above, not here.
                  }}
                  placeholder="Search apps, or paste a token address"
                  aria-label="Search"
                  enterKeyHint="go"
                  className="w-full bg-transparent font-mono text-[16px] text-fg outline-none placeholder:text-faint sm:text-sm"
                />
                <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-faint sm:inline">
                  esc
                </kbd>
              </div>
              <ul role="listbox" aria-label="Results" className="os-launcher-list">
                {results.length === 0 && (
                  <li className="px-3 py-6 text-center font-mono text-xs text-faint">No matches</li>
                )}
                {results.map((hit, i) => {
                  const key = hit.kind === "app" ? hit.app.id : hit.action.id;
                  return (
                    <li
                      key={key}
                      role="option"
                      aria-selected={i === selected}
                      onMouseEnter={() => setCursor(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => activate(hit)}
                      className={`os-launcher-row ${i === selected ? "os-launcher-row--on" : ""}`}
                    >
                      {hit.kind === "app" ? (
                        <span className="flex min-w-0 items-center gap-2">
                          <hit.app.icon className="h-4 w-4 shrink-0" aria-hidden />
                          <span className="truncate font-mono text-xs">{hit.app.name}</span>
                        </span>
                      ) : (
                        <span className="truncate font-mono text-xs">{hit.action.title}</span>
                      )}
                      <span className="hidden max-w-[45%] truncate font-mono text-[11px] text-faint sm:inline">
                        {hit.kind === "app" ? hit.app.blurb : hit.action.hint}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="os-launcher-foot">
                <span>content opens as a window</span>
                <span className="flex items-center gap-1">
                  <CornerDownLeft className="h-3 w-3" />
                  open
                </span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Portal>
  );
}
