"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { buildRegistry, type AppManifest } from "../core";
import { RegistryProvider } from "./registry";
import { useWindowManager } from "./hooks/useWindowManager";
import { useIsTouch } from "./hooks/useIsTouch";
import { DesktopProvider, type DesktopApi, type Tone } from "./desktop-context";
import { WindowManager, type Origin } from "./WindowManager";
import { AppBody } from "./AppBody";
import { DesktopIcons } from "./DesktopIcons";
import { Toasts, type Toast } from "./Toasts";

type Props = {
  apps: AppManifest[];
  brand: string;
  /** Right side of the menu bar: network, wallet, balance. */
  statusSlot?: React.ReactNode;
};

/** The centre of what was clicked, in stage pixels. */
function stagePoint(from: HTMLElement): Origin | null {
  const stage = document.querySelector(".os-stage")?.getBoundingClientRect();
  if (!stage) return null;
  const art = from.querySelector(".os-icon-tile, .os-dock-face") ?? from;
  const r = art.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2 - stage.left), y: Math.round(r.top + r.height / 2 - stage.top) };
}

export function DesktopShell({ apps, brand }: Props) {
  const registry = useMemo(() => buildRegistry(apps), [apps]);
  const { state, actions } = useWindowManager(registry);
  const touch = useIsTouch();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const [origins, setOrigins] = useState<Record<string, Origin>>({});

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

  return (
    <RegistryProvider value={registry}>
      <DesktopProvider value={api}>
        <main className="os-root">
          <h1 className="sr-only">{brand}</h1>
          <div className="os-wallpaper" aria-hidden />
          {!touch && <DesktopIcons onOpen={(id, from) => open(id, {}, from)} />}
          <WindowManager
            windows={state.windows}
            activeId={state.activeId}
            actions={actions}
            touch={touch}
            origins={origins}
            renderBody={(w) => <AppBody win={w} />}
          />
          <Toasts toasts={toasts} />
        </main>
      </DesktopProvider>
    </RegistryProvider>
  );
}
