import type { AppManifest } from "./manifest";

/** A grey app's stage, from its manifest's `release`. A live app (no `comingSoon`) has none — its release needn't be
 * "r0"; Terminal is live on "r1". */
export type Stage = Exclude<AppManifest["release"], "r0">;

/** The stages in the order they come. */
export const STAGE_ORDER: readonly Stage[] = ["r1", "r2", "phase2"];

/** What each stage reads as. Stages, never dates: a claim has to be true on the day it ships. */
export const STAGE_LABEL: Record<Stage, string> = {
  r1: "Next up",
  r2: "After the audit",
  phase2: "Later",
};

/** The label for a release, or null for "r0". A live app (no `comingSoon`) never reaches here — a grey app's release
 * is always "r1", "r2" or "phase2". */
export function stageLabel(release: AppManifest["release"]): string | null {
  return release === "r0" ? null : STAGE_LABEL[release];
}

export type RoadmapEntry = { app: AppManifest; stage: string };

/**
 * The Roadmap: every grey app with its stage, soonest stage first, registry order within a stage. Built from the
 * manifests themselves, so it can never disagree with the grey apps: when an app ships and loses `comingSoon`, its row
 * goes with it.
 */
export function roadmapEntries(list: readonly AppManifest[]): RoadmapEntry[] {
  return list
    .flatMap((app, i) => (app.comingSoon && app.release !== "r0" ? [{ app, i, rank: STAGE_ORDER.indexOf(app.release) }] : []))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ app }) => ({ app, stage: STAGE_LABEL[app.release as Stage] }));
}
