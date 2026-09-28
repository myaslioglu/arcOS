"use client";

import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import { FOLDER_APP_ID, ROADMAP_APP_ID, isCategory, type AppManifest, type AppProps, type DesktopWindow } from "../core";
import { FolderBody } from "./FolderWindow";
import { useRegistry } from "./registry";
import { RoadmapWindow } from "./RoadmapWindow";
import { WindowErrorBoundary } from "./WindowErrorBoundary";
import { WorkInProgress } from "./WorkInProgress";

// A plain object, not a Map: reading `cache[id]` is a property access, so it
// stays a stable reference to eslint's react-hooks static-components check,
// unlike a `Map#get()` call, which that check treats as creating a new
// component on every render.
const cache: Record<string, LazyExoticComponent<ComponentType<AppProps>>> = {};

function ensureCached(m: AppManifest): void {
  if (!cache[m.id]) cache[m.id] = lazy(m.load);
}

/** A rejected `import()` (routine when a tab stays open across a redeploy) leaves `lazy()`
 * re-throwing the same rejected promise forever — "close and reopen" would otherwise do nothing.
 * Dropping the cache entry makes the next `ensureCached` call for this id start a fresh import. */
function dropCached(id: string): void {
  delete cache[id];
}

/**
 * A window's body: one of the desktop's own windows (a folder, the Roadmap), a grey app's "work in progress" window,
 * or the app the window belongs to, loaded on first open.
 */
export function AppBody({ win, repoUrl }: { win: DesktopWindow; repoUrl?: string }) {
  const registry = useRegistry();
  if (win.appId === FOLDER_APP_ID && isCategory(win.instanceKey)) return <FolderBody category={win.instanceKey} />;
  if (win.appId === ROADMAP_APP_ID) return <RoadmapWindow apps={registry.list} />;
  const m = registry.byId.get(win.appId);
  if (!m) return <div className="os-empty">Unknown app: {win.appId}</div>;
  if (m.comingSoon) return <WorkInProgress m={m} repoUrl={repoUrl} />;
  ensureCached(m);
  const App = cache[m.id];
  return (
    <WindowErrorBoundary appName={m.name} onError={() => dropCached(m.id)}>
      <Suspense fallback={<div className="os-loading">Loading…</div>}>
        <App winId={win.winId} params={win.params} />
      </Suspense>
    </WindowErrorBoundary>
  );
}
