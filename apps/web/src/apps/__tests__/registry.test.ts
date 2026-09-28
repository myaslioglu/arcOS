import { describe, expect, it } from "vitest";
import { CATEGORY_HUE, appHue, stageLabel } from "@arcos/shell/core";
import { APPS } from "../registry";

const grey = APPS.filter((m) => m.comingSoon);

describe("APPS", () => {
  it("gives every registered app a hue, coming-soon apps included", () => {
    expect(APPS.some((m) => m.comingSoon)).toBe(true);
    for (const m of APPS) {
      expect(appHue(m), m.id).toMatch(/^var\(--[\w-]+\)$/);
      expect(appHue(m), m.id).toBe(CATEGORY_HUE[m.category]);
    }
  });

  it("gives every grey app two or three sentences on what it will do, and no dates", () => {
    for (const m of grey) {
      expect(m.details?.length ?? 0, m.id).toBeGreaterThanOrEqual(2);
      expect(m.details?.length ?? 0, m.id).toBeLessThanOrEqual(3);
      for (const line of m.details ?? []) {
        expect(line, m.id).toMatch(/^[A-Z][^!]*\.$/);
        expect(line, m.id).not.toMatch(
          /\b(?:19|20)\d\d\b|\b(?:January|February|March|April|June|July|August|September|October|November|December|Q[1-4])\b/,
        );
      }
    }
  });

  it("gives every grey app a stage", () => {
    for (const m of grey) expect(stageLabel(m.release), m.id).not.toBeNull();
  });
});
