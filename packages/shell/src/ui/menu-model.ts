import {
  DESKTOP_VIEWS,
  VIEW_LABEL,
  type AppManifest,
  type DesktopView,
  type DesktopWindow,
  type ThemePreference,
} from "../core";

export type MenuItem = {
  type: "item";
  label: string;
  onSelect: () => void;
  hint?: string;
  disabled?: boolean;
  checked?: boolean;
  role?: "menuitem" | "menuitemradio";
};
/** Items that belong together under a heading, like the theme choices. */
export type MenuGroup = { type: "group"; label: string; items: MenuItem[] };
export type MenuEntry = MenuItem | MenuGroup | { type: "sep" };
/**
 * One menu of the bar. `brand` draws the brand's dot before the label and names the menu for assistive technology;
 * `narrow` keeps the menu on screens below 768px, where the other text menus hide.
 */
export type Menu = { id: string; name: string; label: string; brand?: boolean; narrow?: boolean; entries: MenuEntry[] };

export type MenuActions = {
  search: () => void;
  openApp: (appId: string) => void;
  about: () => void;
  shortcuts: () => void;
  roadmap: () => void;
  github: () => void;
  focus: (winId: string) => void;
  closeActive: () => void;
  minimizeActive: () => void;
  zoomActive: () => void;
  snapActive: (side: "left" | "right") => void;
  tile: () => void;
  minimizeAll: () => void;
  closeAll: () => void;
  view: (view: DesktopView) => void;
  theme: (preference: ThemePreference) => void;
};

export type MenuInput = {
  brand: string;
  apps: readonly AppManifest[];
  windows: readonly DesktopWindow[];
  activeId: string | null;
  view: DesktopView;
  theme: ThemePreference;
  /** Help's GitHub item links here; empty or missing leaves the item off. */
  repoUrl?: string;
  on: MenuActions;
};

export const THEME_CHOICES: { preference: ThemePreference; label: string }[] = [
  { preference: "light", label: "Light" },
  { preference: "dark", label: "Dark" },
  { preference: "system", label: "Match system" },
];

const SEP: MenuEntry = { type: "sep" };
const item = (label: string, onSelect: () => void, extra: Partial<MenuItem> = {}): MenuItem => ({
  type: "item",
  label,
  onSelect,
  ...extra,
});

/**
 * The menu bar's menus, as data. The brand menu holds About and Keyboard shortcuts. File searches, opens any app (a
 * grey one opens its "work in progress" window, so it is hinted "Soon") and closes the focused window. Window is as it
 * was. View picks the desktop's view and the theme, and stays on narrow screens, because "Match system" can't be
 * reached from the theme button. Help holds the shortcuts, the Roadmap, the repository and About.
 */
export function menuModel(input: MenuInput): Menu[] {
  const { brand, on } = input;
  const active = input.windows.find((w) => w.winId === input.activeId) ?? null;
  const visible = input.windows.filter((w) => !w.minimized);
  return [
    {
      id: "brand",
      name: `${brand} menu`,
      label: brand,
      brand: true,
      narrow: true,
      entries: [item(`About ${brand}`, on.about), item("Keyboard shortcuts", on.shortcuts)],
    },
    {
      id: "file",
      name: "File",
      label: "File",
      entries: [
        item("Search…", on.search, { hint: "⌘K / Ctrl+K" }),
        SEP,
        ...input.apps.map((m) => item(`Open ${m.name}`, () => on.openApp(m.id), m.comingSoon ? { hint: "Soon" } : {})),
        SEP,
        item("Close window", on.closeActive, { hint: "Esc", disabled: !active }),
      ],
    },
    {
      id: "window",
      name: "Window",
      label: "Window",
      entries: [
        item("Minimize", on.minimizeActive, { disabled: !active }),
        item(active?.maximized ? "Restore" : "Zoom", on.zoomActive, { disabled: !active }),
        item("Snap left", () => on.snapActive("left"), { disabled: !active }),
        item("Snap right", () => on.snapActive("right"), { disabled: !active }),
        SEP,
        item("Tile windows", on.tile, { disabled: visible.length === 0 }),
        item("Minimize all", on.minimizeAll, { disabled: visible.length === 0 }),
        item("Close all", on.closeAll, { disabled: input.windows.length === 0 }),
        ...(input.windows.length > 0
          ? [
              SEP,
              ...input.windows.map((w) =>
                item(w.title, () => on.focus(w.winId), {
                  role: "menuitemradio" as const,
                  checked: w.winId === input.activeId,
                }),
              ),
            ]
          : []),
      ],
    },
    {
      id: "view",
      name: "View",
      label: "View",
      narrow: true,
      entries: [
        {
          type: "group",
          label: "Desktop",
          items: DESKTOP_VIEWS.map((v) =>
            item(VIEW_LABEL[v], () => on.view(v), { role: "menuitemradio", checked: input.view === v }),
          ),
        },
        SEP,
        {
          type: "group",
          label: "Theme",
          items: THEME_CHOICES.map((c) =>
            item(c.label, () => on.theme(c.preference), { role: "menuitemradio", checked: input.theme === c.preference }),
          ),
        },
      ],
    },
    {
      id: "help",
      name: "Help",
      label: "Help",
      entries: [
        item("Keyboard shortcuts", on.shortcuts),
        item("Roadmap", on.roadmap),
        ...(input.repoUrl ? [item("GitHub ↗", on.github)] : []),
        SEP,
        item(`About ${brand}`, on.about),
      ],
    },
  ];
}
