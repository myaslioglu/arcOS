"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FOLDER_APP_ID,
  buildRegistry,
  dropParams,
  openActionFor,
  parseAppHash,
  snapRect,
  type AppCategory,
  type AppManifest,
  type DeskItem,
  type QuickAction,
} from "../core";
import { RegistryProvider } from "./registry";
import { useWindowManager } from "./hooks/useWindowManager";
import { useIsTouch } from "./hooks/useIsTouch";
import { DesktopProvider, type DesktopApi, type Tone } from "./desktop-context";
import { WindowManager, type Origin } from "./WindowManager";
import { AppBody } from "./AppBody";
import { DeskFolders } from "./DeskFolders";
import { DesktopIcons } from "./DesktopIcons";
import { Dock } from "./Dock";
import { MenuBar } from "./MenuBar";
import { Launcher } from "./Launcher";
import { ContextMenu } from "./ContextMenu";
import { TouchHome } from "./TouchHome";
import { Toasts, type Toast } from "./Toasts";
import { useDesktopView } from "./view";
import { Wallpaper } from "./Wallpaper";

type Props = {
  apps: AppManifest[];
  brand: string;
  /** App opened by "About …". */
  aboutAppId?: string;
  /** Right side of the menu bar: network, wallet, balance. */
  statusSlot?: React.ReactNode;
  /** Extra launcher rows computed from the query, e.g. "Inspect 0x…". */
  quickActions?: (query: string) => QuickAction[];
  /** The public repository, for "Follow progress on GitHub" in grey apps' windows. Empty or missing: the link is left off. */
  repoUrl?: string;
  /** The desk's items, down its last column in the Folders view: files that open a window, links that open a tab. */
  deskItems?: DeskItem[];
  /** Drawn into the wallpaper over its grid, glow and noise: the live chart. */
  wallpaperSlot?: React.ReactNode;
};

const NO_ITEMS: DeskItem[] = [];

function stagePoint(from: HTMLElement): Origin | null {
  const stage = document.querySelector(".os-stage")?.getBoundingClientRect();
  if (!stage) return null;
  // The art inside what was clicked (a folder, a file's page, an icon or dock tile): the window grows out of its centre.
  const art = from.querySelector(".os-folder, .os-file, .os-icon-tile, .os-dock-face") ?? from;
  const r = art.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2 - stage.left), y: Math.round(r.top + r.height / 2 - stage.top) };
}

function stageSize(): { w: number; h: number } {
  const box = document.querySelector(".os-stage")?.getBoundingClientRect();
  return { w: box?.width ?? window.innerWidth, h: box?.height ?? window.innerHeight };
}

export function DesktopShell({
  apps,
  brand,
  aboutAppId = "about",
  statusSlot,
  quickActions,
  repoUrl,
  deskItems = NO_ITEMS,
  wallpaperSlot,
}: Props) {
  const registry = useMemo(() => buildRegistry(apps), [apps]);
  const { state, actions } = useWindowManager(registry);
  const touch = useIsTouch();
  const view = useDesktopView();
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
      // A grey app opens its "work in progress" window like any other (see openActionFor).
      const action = openActionFor(registry, appId, params);
      if (!action) return false;
      // Keyed like the window itself (see WindowManager's `origins`), so a folder's window grows out of that folder.
      const key = `${action.appId}:${action.instanceKey}`;
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
    [actions, registry],
  );

  const openFolder = useCallback(
    (category: AppCategory, from: HTMLElement) => {
      open(FOLDER_APP_ID, { group: category }, from);
    },
    [open],
  );

  // A desk item that opens a window (readme.txt, roadmap.txt) comes here; a link is an <a> and opens its own tab.
  const openDeskItem = useCallback(
    (item: DeskItem, from: HTMLElement) => {
      if (item.action.kind === "app") open(item.action.appId, {}, from);
    },
    [open],
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
  // cleared with replaceState right after handling it — for an unknown app id too,
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
          <Wallpaper>{wallpaperSlot}</Wallpaper>
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
          ) : view === "folders" ? (
            <DeskFolders apps={registry.list} items={deskItems} onOpenFolder={openFolder} onOpenItem={openDeskItem} />
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
            renderBody={(w) => <AppBody win={w} repoUrl={repoUrl} />}
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
