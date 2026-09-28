import { describe, expect, it } from "vitest";
import type { AppManifest } from "../manifest";
import { STAGE_LABEL, roadmapEntries, stageLabel } from "../roadmap";

const app = (id: string, release: AppManifest["release"], comingSoon = true): AppManifest => ({
  id,
  name: id,
  blurb: "",
  icon: (() => null) as unknown as AppManifest["icon"],
  category: "trust",
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release,
  comingSoon,
});

describe("stageLabel", () => {
  it("names each stage from the manifest's release, and none for the live release", () => {
    expect(stageLabel("r1")).toBe("Next up");
    expect(stageLabel("r2")).toBe("After the audit");
    expect(stageLabel("phase2")).toBe("Later");
    expect(stageLabel("r0")).toBeNull();
    expect(Object.keys(STAGE_LABEL)).toEqual(["r1", "r2", "phase2"]);
  });
});

describe("roadmapEntries", () => {
  it("lists only the grey apps, soonest stage first, registry order within a stage", () => {
    const list = [
      app("vault", "r2"),
      app("finder", "r0", false),
      app("watchdog", "r1"),
      app("terminal", "phase2"),
      app("radar", "r1"),
      app("mint", "r1", false),
    ];
    expect(roadmapEntries(list).map((e) => [e.app.id, e.stage])).toEqual([
      ["watchdog", "Next up"],
      ["radar", "Next up"],
      ["vault", "After the audit"],
      ["terminal", "Later"],
    ]);
  });

  it("leaves out a grey app still marked r0, which has no stage to show", () => {
    expect(roadmapEntries([app("odd", "r0")])).toEqual([]);
  });
});
