"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildRegistry, dropParams, parseAppHash, snapRect, type AppManifest, type QuickAction } from "../core";
import { RegistryProvider } from "./registry";
import { useWindowManager } from "./hooks/useWindowManager";
import { useIsTouch } from "./hooks/useIsTouch";
import { DesktopProvider, type DesktopApi, type Tone } from "./desktop-context";
import { WindowManager, type Origin } from "./WindowManager";
import { AppBody } from "./AppBody";
import { DesktopIcons } from "./DesktopIcons";
import { Dock } from "./Dock";
import { MenuBar } from "./MenuBar";
import { Launcher } from "./Launcher";
import { ContextMenu } from "./ContextMenu";
import { TouchHome } from "./TouchHome";
import { Toasts, type Toast } from "./Toasts";

type Props = {
  apps: AppManifest[];
  brand: string;
  /** App opened by "About …". */
  aboutAppId?: string;
  /** Right side of the menu bar: network, wallet, balance. */
  statusSlot?: React.ReactNode;
  /** Extra launcher rows computed from the query, e.g. "Inspect 0x…". */
  quickActions?: (query: string) => QuickAction[];
};

function stagePoint(from: HTMLElement): Origin | null {
  const stage = document.querySelector(".os-stage")?.getBoundingClientRect();
  if (!stage) return null;
  const art = from.querySelector(".os-icon-tile, .os-dock-face") ?? from;
  const r = art.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2 - stage.left), y: Math.round(r.top + r.height / 2 - stage.top) };
}

function stageSize(): { w: number; h: number } {
  const box = document.querySelector(".os-stage")?.getBoundingClientRect();
  return { w: box?.width ?? window.innerWidth, h: box?.height ?? window.innerHeight };
}

export function DesktopShell({ apps, brand, aboutAppId = "about", statusSlot, quickActions }: Props) {
  const registry = useMemo(() => buildRegistry(apps), [apps]);
  const { state, actions } = useWindowManager(registry);
  const touch = useIsTouch();
  const [launcher, setLauncher] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const [origins, setOrigins] = useState<Record<string, Origin>>({});
  const active = state.windows.find((w) => w.winId === state.activeId) ?? null;

  const notify = useCallback((text: string, tone: Tone = "info", ms = 3600) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), ms);
  }, []);

  const open = useCallback(
    (appId: string, params: Record<string, string> = {}, from?: HTMLElement) => {
      const m = registry.byId.get(appId);
      if (!m) return false;
      if (m.comingSoon) {
        notify(`${m.name} isn't available yet.`, "info");
        return false;
      }
      const key = `${appId}:${m.instanceKey ? m.instanceKey(params) : ""}`;
      const point = from ? stagePoint(from) : null;
      setOrigins((all) => {
        if (point) return { ...all, [key]: point };
        if (!(key in all)) return all;
        const rest = { ...all };
        delete rest[key];
        return rest;
      });
      return actions.open(appId, params);
    },
    [actions, notify, registry],
  );

  const api = useMemo<DesktopApi>(
    () => ({ notify, open, close: actions.close, setTitle: actions.setTitle }),
    [notify, open, actions],
  );

  const tile = useCallback(() => {
    const s = stageSize();
    actions.tile(s.w, s.h);
  }, [actions]);

  const snapActive = (side: "left" | "right") => {
    if (!active) return;
    const s = stageSize();
    actions.setRect(active.winId, snapRect(side, s.w, s.h));
  };

  const shortcuts = () =>
    notify(
      "⌘K / Ctrl+K search · Esc closes a window · double-click a title to zoom · drag to an edge to snap · right-click for the desktop menu",
      "info",
      8000,
    );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLauncher((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Deep links: /#app:inspector?token=0x… opens that window, on load and on change. The hash is
  // cleared with replaceState right after handling it — for an unknown or coming-soon app id too,
  // not just a successful open — so the same link can be clicked again later: leaving the hash in
  // place means a second click on an identical link never fires `hashchange` at all. replaceState
  // never fires `hashchange` itself, so this can't loop.
  useEffect(() => {
    const openFromHash = () => {
      const target = parseAppHash(window.location.hash);
      if (!target) return;
      open(target.appId, target.params);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    const frame = requestAnimationFrame(openFromHash);
    window.addEventListener("hashchange", openFromHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", openFromHash);
    };
  }, [open]);

  const onContextMenu = (e: React.MouseEvent) => {
    if (touch) return;
    const target = e.target as HTMLElement;
    if (
      target.closest(
        ".os-window, .os-dock, .os-topbar, .os-launcher-veil, .os-ctx, .os-toasts, input, textarea, a, button",
      )
    ) {
      return;
    }
    e.preventDefault();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };

  return (
    <RegistryProvider value={registry}>
      <DesktopProvider value={api}>
        <main className="os-root" onContextMenu={onContextMenu}>
          <h1 className="sr-only">{brand}</h1>
          <div className="os-wallpaper" aria-hidden />
          <MenuBar
            brand={brand}
            windows={state.windows}
            activeId={state.activeId}
            onSearch={() => setLauncher(true)}
            onOpenApp={(id) => open(id)}
            onAbout={() => open(aboutAppId)}
            onFocus={actions.focus}
            onCloseActive={() => active && actions.close(active.winId)}
            onMinimizeActive={() => active && actions.minimize(active.winId)}
            onZoomActive={() => active && actions.toggleMax(active.winId)}
            onSnapActive={snapActive}
            onTile={tile}
            onMinimizeAll={actions.minimizeAll}
            onCloseAll={actions.closeAll}
            onShortcuts={shortcuts}
            statusSlot={statusSlot}
          />
          {touch ? (
            <TouchHome
              activeId={state.activeId}
              onOpen={(id, from) => open(id, {}, from)}
              onBack={() => state.activeId && actions.minimize(state.activeId)}
            />
          ) : (
            <DesktopIcons
              onOpen={(id, from) => open(id, {}, from)}
              onDropItem={(id, item, from) => open(id, dropParams(item), from)}
            />
          )}
          <WindowManager
            windows={state.windows}
            activeId={state.activeId}
            actions={actions}
            touch={touch}
            origins={origins}
            renderBody={(w) => <AppBody win={w} />}
          />
          <Dock
            windows={state.windows}
            activeId={state.activeId}
            onOpenPinned={(id, from) => open(id, {}, from)}
            onDropItem={(id, item, from) => open(id, dropParams(item), from)}
            onFocus={actions.focus}
            onClose={actions.close}
            onCloseAll={actions.closeAll}
            onLauncher={() => setLauncher(true)}
          />
          <Launcher
            open={launcher}
            onClose={() => setLauncher(false)}
            quickActions={quickActions}
            onPickApp={(id) => open(id)}
            onPickAction={(a) => open(a.appId, a.params)}
          />
          {menuAt && (
            <ContextMenu
              x={menuAt.x}
              y={menuAt.y}
              hasWindows={state.windows.length > 0}
              onClose={() => setMenuAt(null)}
              onTile={tile}
              onMinimizeAll={actions.minimizeAll}
              onCloseAll={actions.closeAll}
              onAbout={() => open(aboutAppId)}
            />
          )}
          <Toasts toasts={toasts} />
        </main>
      </DesktopProvider>
    </RegistryProvider>
  );
}
