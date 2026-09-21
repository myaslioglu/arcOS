"use client";

import { useMemo, useState } from "react";
import { CATEGORY_LABEL, CATEGORY_ORDER, type AppManifest } from "../core";
import { useRegistry } from "./registry";
import { TouchRow } from "./TouchRow";

type Props = {
  activeId: string | null;
  onOpen: (appId: string, from: HTMLElement) => void;
  onBack: () => void;
};

/**
 * Touch home: a search box over one row list per category. Typing flattens
 * every app into a single filtered list; with a window open behind it, the
 * home collapses to a "back" button so it never fights the pinned window
 * for the screen.
 */
export function TouchHome({ activeId, onOpen, onBack }: Props) {
  const { list } = useRegistry();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();

  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((c) => ({
        key: c,
        label: CATEGORY_LABEL[c],
        apps: list.filter((m) => m.category === c),
      })).filter((g) => g.apps.length > 0),
    [list],
  );

  if (activeId) {
    return (
      <div className="os-touch-home os-touch-home--behind">
        <button type="button" onClick={onBack} className="os-back">
          {"< all apps"}
        </button>
      </div>
    );
  }

  const matches = (m: AppManifest) => `${m.name} ${m.blurb}`.toLowerCase().includes(needle);

  return (
    <div className="os-touch-home">
      <div className="os-touch-top">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search apps"
          aria-label="search"
          className="os-touch-search"
        />
      </div>
      {needle ? (
        <ul className="os-touch-list">
          {list.filter(matches).map((m) => (
            <TouchRow key={m.id} m={m} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="os-touch-group" data-group={g.key}>
            <h2 className="os-touch-plate">
              <span className="os-tray-led" aria-hidden />
              {g.label}
              <span className="os-tray-count">{g.apps.length}</span>
            </h2>
            <ul className="os-touch-list">
              {g.apps.map((m) => (
                <TouchRow key={m.id} m={m} onOpen={onOpen} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
