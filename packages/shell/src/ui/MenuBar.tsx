"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { DesktopWindow } from "../core";
import { useRegistry } from "./registry";

type Item = {
  type: "item";
  label: string;
  onSelect: () => void;
  hint?: string;
  disabled?: boolean;
  checked?: boolean;
  role?: "menuitem" | "menuitemradio";
};
type Entry = Item | { type: "sep" };
type Menu = { id: string; label: React.ReactNode; name: string; entries: Entry[]; brand?: boolean };

const SEP: Entry = { type: "sep" };
const item = (label: string, onSelect: () => void, extra: Partial<Item> = {}): Item => ({
  type: "item",
  label,
  onSelect,
  ...extra,
});

type Props = {
  brand: string;
  windows: DesktopWindow[];
  activeId: string | null;
  onSearch: () => void;
  onOpenApp: (appId: string) => void;
  onAbout: () => void;
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

/**
 * The menu bar of a real computer: the brand menu, then File and Window,
 * each doing something real. On the right, the status slot then the clock.
 *
 * Menus open on click and, while one is open, follow the pointer to the next
 * title. The keyboard gets the same: Enter or ↓ opens a menu on its first
 * item, ↑ ↓ walk it, ← → step to the neighbouring menu, Esc closes.
 */
export function MenuBar(props: Props) {
  const { brand, windows, activeId } = props;
  const { list } = useRegistry();
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const titles = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusFirst = useRef(false);
  const clock = useClock();

  const active = windows.find((w) => w.winId === activeId) ?? null;
  const visible = windows.filter((w) => !w.minimized);

  const menus: Menu[] = [
    {
      id: "brand",
      brand: true,
      name: `${brand} menu`,
      label: (
        <>
          <span className="os-brand-dot" aria-hidden />
          {brand}
        </>
      ),
      entries: [item(`About ${brand}`, props.onAbout), item("Keyboard shortcuts", props.onShortcuts)],
    },
    {
      id: "file",
      name: "File",
      label: "File",
      entries: [
        item("Search…", props.onSearch, { hint: "⌘K" }),
        SEP,
        ...list.filter((m) => !m.comingSoon).map((m) => item(`Open ${m.name}`, () => props.onOpenApp(m.id))),
        SEP,
        item("Close window", props.onCloseActive, { hint: "Esc", disabled: !active }),
      ],
    },
    {
      id: "window",
      name: "Window",
      label: "Window",
      entries: [
        item("Minimize", props.onMinimizeActive, { disabled: !active }),
        item("Zoom", props.onZoomActive, { disabled: !active }),
        item("Snap left", () => props.onSnapActive("left"), { disabled: !active }),
        item("Snap right", () => props.onSnapActive("right"), { disabled: !active }),
        SEP,
        item("Tile all", props.onTile, { disabled: visible.length === 0 }),
        item("Minimize all", props.onMinimizeAll, { disabled: visible.length === 0 }),
        item("Close all", props.onCloseAll, { disabled: windows.length === 0 }),
        ...(windows.length > 0
          ? [
              SEP,
              ...windows.map((w) =>
                item(w.title, () => props.onFocus(w.winId), {
                  role: "menuitemradio" as const,
                  checked: w.winId === activeId,
                }),
              ),
            ]
          : []),
      ],
    },
  ];

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

  const renderEntry = (entry: Entry, key: number) => {
    if (entry.type === "sep") return <div key={key} role="separator" className="os-menu-sep" />;
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
          <div key={m.id} className={m.brand ? "os-menu" : "os-menu os-menu--text"}>
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
              {m.label}
            </button>
            {open === m.id && (
              <div role="menu" aria-label={m.name} className="os-menu-panel" onKeyDown={onPanelKey}>
                {m.entries.map(renderEntry)}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="os-topbar-right">
        {props.statusSlot}
        <span className="os-clock tabular-nums" suppressHydrationWarning>
          {clock ?? "--:--"}
        </span>
      </div>
    </header>
  );
}
