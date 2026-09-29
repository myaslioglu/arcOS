"use client";

import { useState } from "react";
import { Folder, List } from "lucide-react";
import {
  CATEGORY_HUE,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  DESKTOP_VIEWS,
  TOUCH_VIEW_LABEL,
  folderContents,
  type AppCategory,
  type AppManifest,
  type DeskItem,
  type DesktopView,
} from "../core";
import { DeskItemCell, FolderCell } from "./DeskCells";
import { useRegistry } from "./registry";
import { TouchRow } from "./TouchRow";
import { setDesktopView, useDesktopView } from "./view";

export type TouchHomeViewProps = {
  apps: readonly AppManifest[];
  view: DesktopView;
  filter: string;
  deskItems: readonly DeskItem[];
  onFilter: (text: string) => void;
  onView: (view: DesktopView) => void;
  onOpen: (appId: string, from: HTMLElement) => void;
  onOpenFolder: (category: AppCategory, from: HTMLElement) => void;
  onOpenDeskItem: (item: DeskItem, from: HTMLElement) => void;
};

/**
 * The touch home, drawn from its props (hookless, so a test can call it): a search box beside the Folders / List
 * switch, then either a three-column grid of the folders and the desk items, or today's category lists. Typing
 * flattens every app into one filtered list. Grey apps are tagged "Soon" in every list.
 */
export function TouchHomeView({
  apps,
  view,
  filter,
  deskItems,
  onFilter,
  onView,
  onOpen,
  onOpenFolder,
  onOpenDeskItem,
}: TouchHomeViewProps) {
  const needle = filter.trim().toLowerCase();
  const groups = CATEGORY_ORDER.map((category) => ({ category, apps: folderContents(apps, category) })).filter(
    (g) => g.apps.length > 0,
  );
  const matches = (m: AppManifest) => `${m.name} ${m.blurb}`.toLowerCase().includes(needle);

  return (
    <div className="os-touch-home">
      <div className="os-touch-top">
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="Search apps"
          aria-label="search"
          className="os-touch-search"
        />
        <div role="group" aria-label="View" className="os-touch-views">
          {DESKTOP_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              aria-label={TOUCH_VIEW_LABEL[v]}
              onClick={() => onView(v)}
              className="os-touch-view"
            >
              {v === "folders" ? <Folder aria-hidden /> : <List aria-hidden />}
            </button>
          ))}
        </div>
      </div>
      {needle ? (
        <ul className="os-touch-list">
          {apps.filter(matches).map((m) => (
            <TouchRow key={m.id} m={m} onOpen={onOpen} />
          ))}
        </ul>
      ) : view === "folders" ? (
        <div className="os-touch-folders">
          {groups.map((g) => (
            <FolderCell key={g.category} category={g.category} apps={g.apps} onOpen={onOpenFolder} />
          ))}
          {deskItems.map((item) => (
            <DeskItemCell key={item.id} item={item} loose={false} onOpen={onOpenDeskItem} />
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <section
            key={g.category}
            className="os-touch-group"
            data-group={g.category}
            style={{ "--os-group": CATEGORY_HUE[g.category] } as React.CSSProperties}
          >
            <h2 className="os-touch-plate">
              <span className="os-tray-led" aria-hidden />
              {CATEGORY_LABEL[g.category]}
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

type Props = {
  activeId: string | null;
  deskItems: readonly DeskItem[];
  onOpen: (appId: string, from: HTMLElement) => void;
  onOpenFolder: (category: AppCategory, from: HTMLElement) => void;
  onOpenDeskItem: (item: DeskItem, from: HTMLElement) => void;
  onBack: () => void;
};

/**
 * Touch home. The Folders / List switch shares the desktop's `arcos-view` preference (Folders is Folders, List is
 * Trays). With a window open, windows being full screen one at a time on touch, the home collapses to a "back" button
 * so it never fights that window for the screen.
 */
export function TouchHome({ activeId, deskItems, onOpen, onOpenFolder, onOpenDeskItem, onBack }: Props) {
  const { list } = useRegistry();
  const view = useDesktopView();
  const [filter, setFilter] = useState("");

  if (activeId) {
    return (
      <div className="os-touch-home os-touch-home--behind">
        <button type="button" onClick={onBack} className="os-back">
          {"< all apps"}
        </button>
      </div>
    );
  }

  return (
    <TouchHomeView
      apps={list}
      view={view}
      filter={filter}
      deskItems={deskItems}
      onFilter={setFilter}
      onView={setDesktopView}
      onOpen={onOpen}
      onOpenFolder={onOpenFolder}
      onOpenDeskItem={onOpenDeskItem}
    />
  );
}
