"use client";

import { useMemo } from "react";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "../core";
import { useRegistry } from "./registry";

type Props = {
  onOpen: (appId: string, from: HTMLElement) => void;
};

/**
 * The instrument rack: one tray per category, built from the same bezel,
 * plate and LED as the hero's devices, placed on a named grid so the rack
 * spans the width instead of running down the left edge.
 *
 * Single click or Enter opens; there is no double-click, so touch and
 * keyboard behave the same. Windows live on a higher plane and only their
 * frames take pointer events, so the rack stays usable with windows open.
 */
export function DesktopIcons({ onOpen }: Props) {
  const { list } = useRegistry();
  const trays = useMemo(
    () =>
      CATEGORY_ORDER.map((c) => ({
        key: c,
        label: CATEGORY_LABEL[c],
        apps: list.filter((m) => m.category === c),
      })).filter((t) => t.apps.length > 0),
    [list],
  );

  return (
    <div className="os-icons">
      {trays.map((t) => (
        <section key={t.key} className="os-tray" data-group={t.key} aria-labelledby={`os-tray-${t.key}`}>
          <header className="os-tray-plate">
            <span className="os-tray-led" aria-hidden />
            <h2 id={`os-tray-${t.key}`} className="os-tray-label">
              {t.label}
            </h2>
            <span className="os-tray-count">{t.apps.length}</span>
          </header>
          <div className="os-tray-screen">
            {t.apps.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={(e) => onOpen(m.id, e.currentTarget)}
                data-soon={m.comingSoon ? "true" : undefined}
                aria-label={m.name}
                className="os-icon"
                style={m.hue ? ({ "--os-hue": m.hue } as React.CSSProperties) : undefined}
              >
                <span className="os-icon-tile">
                  <m.icon size={26} strokeWidth={1.6} aria-hidden />
                </span>
                <span className="os-icon-name">{m.name}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
