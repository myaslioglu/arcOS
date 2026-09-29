"use client";

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Moon, Search, Sun } from "lucide-react";
import { shortcutLabel, type DesktopWindow } from "../core";
import { menuModel, type MenuEntry } from "./menu-model";
import { useRegistry } from "./registry";
import { setThemePreference, toggleTheme, useTheme } from "./theme";
import { setDesktopView, useDesktopView } from "./view";

type Props = {
  brand: string;
  windows: DesktopWindow[];
  activeId: string | null;
  /** Names the View menu's Desktop group the way the touch switch does ("List", not "Trays"). */
  touch: boolean;
  /** Help's GitHub item opens this in a new tab; empty or missing leaves the item off. */
  repoUrl?: string;
  onSearch: () => void;
  onOpenApp: (appId: string) => void;
  onAbout: () => void;
  onRoadmap: () => void;
  onFocus: (winId: string) => void;
  onCloseActive: () => void;
  onMinimizeActive: () => void;
  onZoomActive: () => void;
  onSnapActive: (side: "left" | "right") => void;
  onTile: () => void;
  onMinimizeAll: () => void;
  onCloseAll: () => void;
  onShortcuts: () => void;
  statusSlot?: React.ReactNode;
};

/** Client-only clock with the date: null through prerender so markup matches. */
function useClock(): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(
        `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}  ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
      );
    };
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

const noSubscribe = () => () => {};
const serverShortcut = () => "⌘K";

/** "⌘K" on Apple devices, "Ctrl K" elsewhere; "⌘K" through prerender, so markup matches. */
function useShortcut(): string {
  return useSyncExternalStore(noSubscribe, () => shortcutLabel(navigator.userAgent), serverShortcut);
}

/**
 * The menu bar of a real computer: the brand menu and the focused window's title ("Desktop" with none), then File,
 * Window, View and Help, each doing something real (see menu-model.ts). On the right, the status slot, the theme
 * switch, the search pill and the clock.
 *
 * Menus open on click and, while one is open, follow the pointer to the next title. The keyboard gets the same: Enter
 * or ↓ opens a menu on its first item, ↑ ↓ walk it, ← → step to the neighbouring menu, Esc closes.
 */
export function MenuBar(props: Props) {
  const { brand, windows, activeId, touch, repoUrl } = props;
  const { list } = useRegistry();
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const titles = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusFirst = useRef(false);
  const clock = useClock();
  const theme = useTheme();
  const view = useDesktopView();
  const shortcut = useShortcut();
  const switchLabel = theme.resolved === "dark" ? "Switch to light theme" : "Switch to dark theme";
  const active = windows.find((w) => w.winId === activeId) ?? null;

  const menus = menuModel({
    brand,
    apps: list,
    windows,
    activeId,
    view,
    theme: theme.preference,
    touch,
    repoUrl,
    on: {
      search: props.onSearch,
      openApp: props.onOpenApp,
      about: props.onAbout,
      shortcuts: props.onShortcuts,
      roadmap: props.onRoadmap,
      github: () => {
        if (repoUrl) window.open(repoUrl, "_blank", "noopener,noreferrer");
      },
      focus: props.onFocus,
      closeActive: props.onCloseActive,
      minimizeActive: props.onMinimizeActive,
      zoomActive: props.onZoomActive,
      snapActive: props.onSnapActive,
      tile: props.onTile,
      minimizeAll: props.onMinimizeAll,
      closeAll: props.onCloseAll,
      view: setDesktopView,
      theme: setThemePreference,
    },
  });

  // Any click outside the bar closes the menu; Esc closes it and hands focus
  // back to its title, before a window below can read Esc as "close".
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      titles.current[open]?.focus();
      setOpen(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // A menu opened from the keyboard starts on its first item.
  useEffect(() => {
    if (!open || !focusFirst.current) return;
    focusFirst.current = false;
    barRef.current
      ?.querySelector<HTMLButtonElement>(".os-menu-panel [role^='menuitem']:not(:disabled)")
      ?.focus();
  }, [open]);

  const step = (dir: 1 | -1) => {
    const i = menus.findIndex((m) => m.id === open);
    focusFirst.current = true;
    setOpen(menus[(i + dir + menus.length) % menus.length].id);
  };

  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)"),
    ];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === "Tab") {
      setOpen(null);
    }
  };

  const renderEntry = (entry: MenuEntry, key: number) => {
    if (entry.type === "sep") return <div key={key} role="separator" className="os-menu-sep" />;
    if (entry.type === "group") {
      return (
        <div key={key} role="group" aria-label={entry.label}>
          <div className="os-menu-heading" aria-hidden>
            {entry.label}
          </div>
          {entry.items.map(renderEntry)}
        </div>
      );
    }
    const role = entry.role ?? "menuitem";
    return (
      <button
        key={key}
        type="button"
        role={role}
        aria-checked={role === "menuitem" ? undefined : Boolean(entry.checked)}
        disabled={entry.disabled}
        onClick={() => {
          setOpen(null);
          entry.onSelect();
        }}
        className="os-menu-item"
      >
        <span className="os-menu-check" aria-hidden>
          {entry.checked ? <Check className="h-3 w-3" /> : null}
        </span>
        <span className="os-menu-label">{entry.label}</span>
        {entry.hint && <span className="os-menu-hint">{entry.hint}</span>}
      </button>
    );
  };

  return (
    <header className="os-topbar os-menubar">
      <nav ref={barRef} aria-label="menu bar" className="os-menus">
        {menus.map((m) => (
          <Fragment key={m.id}>
            <div className={m.narrow ? "os-menu" : "os-menu os-menu--text"}>
              <button
                ref={(el) => {
                  titles.current[m.id] = el;
                }}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open === m.id}
                aria-label={m.brand ? m.name : undefined}
                onClick={(e) => {
                  // A keyboard "click" carries no pointer detail.
                  if (e.detail === 0) focusFirst.current = true;
                  setOpen(open === m.id ? null : m.id);
                }}
                onPointerEnter={() => {
                  if (open && open !== m.id) setOpen(m.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    focusFirst.current = true;
                    setOpen(m.id);
                  }
                }}
                data-cursor="hover"
                className={m.brand ? "os-menu-title os-menu-title--brand" : "os-menu-title"}
              >
                {m.brand && <span className="os-brand-dot" aria-hidden />}
                {m.label}
              </button>
              {open === m.id && (
                <div role="menu" aria-label={m.name} className="os-menu-panel" onKeyDown={onPanelKey}>
                  {m.entries.map(renderEntry)}
                </div>
              )}
            </div>
            {m.brand && <span className="os-app-name">{active?.title ?? "Desktop"}</span>}
          </Fragment>
        ))}
      </nav>
      <div className="os-topbar-right">
        {props.statusSlot}
        {/* Both glyphs render; CSS shows the one for <html data-theme>, which the boot script sets
            before the first paint, so the icon is right even before this component hydrates. */}
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={switchLabel}
          title={switchLabel}
          data-cursor="hover"
          className="os-theme-btn"
        >
          <Sun className="os-theme-sun" aria-hidden />
          <Moon className="os-theme-moon" aria-hidden />
        </button>
        <button
          type="button"
          onClick={props.onSearch}
          aria-label={`Search (${shortcut})`}
          title={`Search (${shortcut})`}
          data-cursor="hover"
          className="os-search-pill"
        >
          <Search aria-hidden />
          <kbd>{shortcut}</kbd>
        </button>
        <span className="os-clock tabular-nums" suppressHydrationWarning>
          {clock ?? "--:--"}
        </span>
      </div>
    </header>
  );
}
