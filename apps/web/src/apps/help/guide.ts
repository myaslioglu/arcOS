import type { NetworkId } from "@arcos/chain";
import { CATEGORY_LABEL, CATEGORY_ORDER, folderContents, stageLabel, type AppCategory, type AppManifest } from "@arcos/shell/core";
import { APP_GUIDE, MAINNET_ONLY } from "./copy";

/** One app's card in "What can I do here?". */
export type GuideCard = {
  app: AppManifest;
  /** What it does: Help's own line for a live app, or the grey app's first sentence of what it will do. */
  what: string;
  /** When you would use it; null for an app Help has no line for. */
  when: string | null;
  /** A grey app's stage ("After the audit"), or null for a live one. */
  stage: string | null;
  /** "Mainnet only" for an app that reads mainnet data, on the testnet site; otherwise null. */
  note: string | null;
};

export type GuideGroup = { category: AppCategory; label: string; cards: GuideCard[] };

/**
 * The apps the guide describes, folder by folder, from the list the desktop itself shows (the registry, which already
 * holds this network's apps: a gated app is live where its contract is set and grey elsewhere). Left out: Help itself,
 * and a tagged app (such as one tagged "Soon"), whose window says no more than its tag, so the guide has nothing to add.
 */
export function guideGroups(list: readonly AppManifest[], network: NetworkId, self = "help"): GuideGroup[] {
  const listed = list.filter((m) => m.id !== self && (m.comingSoon || !m.tag));
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    cards: folderContents(listed, category).map((app) => cardFor(app, network)),
  })).filter((g) => g.cards.length > 0);
}

function cardFor(app: AppManifest, network: NetworkId): GuideCard {
  const guide = Object.hasOwn(APP_GUIDE, app.id) ? APP_GUIDE[app.id] : undefined;
  if (app.comingSoon) {
    return { app, what: app.details?.[0] ?? app.blurb, when: guide?.when ?? null, stage: stageLabel(app.release), note: null };
  }
  return {
    app,
    what: guide?.what ?? app.blurb,
    when: guide?.when ?? null,
    stage: null,
    note: guide?.mainnetOnly && network !== "mainnet" ? MAINNET_ONLY : null,
  };
}
