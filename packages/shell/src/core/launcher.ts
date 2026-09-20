import type { AppManifest } from "./manifest";

export type QuickAction = {
  id: string;
  title: string;
  hint: string;
  appId: string;
  params: Record<string, string>;
};

export type LauncherHit = { kind: "action"; action: QuickAction } | { kind: "app"; app: AppManifest };

function rank(m: AppManifest, q: string): number {
  const name = m.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (m.blurb.toLowerCase().includes(q)) return 3;
  return -1;
}

/** Quick actions first, then apps by match quality; registry order breaks ties. */
export function searchLauncher(list: AppManifest[], query: string, actions: QuickAction[] = []): LauncherHit[] {
  const q = query.trim().toLowerCase();
  const ranked = list
    .map((app, i) => ({ app, i, r: q === "" ? 0 : rank(app, q) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i);
  return [
    ...actions.map((action) => ({ kind: "action" as const, action })),
    ...ranked.map(({ app }) => ({ kind: "app" as const, app })),
  ];
}
