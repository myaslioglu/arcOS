"use client";

import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { AppManifest, AppProps, DesktopWindow } from "../core";
import { useRegistry } from "./registry";
import { WindowErrorBoundary } from "./WindowErrorBoundary";

// A plain object, not a Map: reading `cache[id]` is a property access, so it
// stays a stable reference to eslint's react-hooks static-components check,
// unlike a `Map#get()` call, which that check treats as creating a new
// component on every render.
const cache: Record<string, LazyExoticComponent<ComponentType<AppProps>>> = {};

function ensureCached(m: AppManifest): void {
  if (!cache[m.id]) cache[m.id] = lazy(m.load);
}

export function AppBody({ win }: { win: DesktopWindow }) {
  const m = useRegistry().byId.get(win.appId);
  if (!m) return <div className="os-empty">Unknown app: {win.appId}</div>;
  ensureCached(m);
  const App = cache[m.id];
  return (
    <WindowErrorBoundary appName={m.name}>
      <Suspense fallback={<div className="os-loading">Loading…</div>}>
        <App winId={win.winId} params={win.params} />
      </Suspense>
    </WindowErrorBoundary>
  );
}
