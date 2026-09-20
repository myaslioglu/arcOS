"use client";

import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { AppManifest, AppProps, DesktopWindow } from "../core";
import { useRegistry } from "./registry";
import { WindowErrorBoundary } from "./WindowErrorBoundary";

const cache = new Map<string, LazyExoticComponent<ComponentType<AppProps>>>();

function lazyFor(m: AppManifest) {
  let c = cache.get(m.id);
  if (!c) {
    c = lazy(m.load);
    cache.set(m.id, c);
  }
  return c;
}

export function AppBody({ win }: { win: DesktopWindow }) {
  const m = useRegistry().byId.get(win.appId);
  if (!m) return <div className="os-empty">Unknown app: {win.appId}</div>;
  const App = lazyFor(m);
  return (
    <WindowErrorBoundary appName={m.name}>
      <Suspense fallback={<div className="os-loading">Loading…</div>}>
        <App winId={win.winId} params={win.params} />
      </Suspense>
    </WindowErrorBoundary>
  );
}
