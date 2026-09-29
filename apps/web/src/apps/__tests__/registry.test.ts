import { describe, expect, it } from "vitest";
import { CATEGORY_HUE, appHue, stageLabel } from "@arcos/shell/core";
import { APPS } from "../registry";

const grey = APPS.filter((m) => m.comingSoon);

// What dates a sentence: a year, a month or a quarter. Case-sensitive, so the modal verb "may" isn't read as May.
const DATES = /\b(?:19|20)\d\d\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4])\b/;

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
        expect(line, m.id).not.toMatch(DATES);
      }
    }
  });

  it("gives every grey app a stage", () => {
    for (const m of grey) expect(stageLabel(m.release), m.id).not.toBeNull();
  });
});

// Inspector reports evidence and "N of M checks pass", never a number that ranks a token, so no grey app may promise one.
const SCORE = /\bscor/i;
/** What a line may say about a score: that there is none. */
const withoutTheDenial = (line: string) => line.replaceAll("never a score", "");

describe("the no-score rule", () => {
  it("keeps every grey app's blurb and details free of a score, except to say there is none", () => {
    for (const m of grey) {
      expect(m.blurb, m.id).not.toMatch(SCORE);
      for (const line of m.details ?? []) expect(withoutTheDenial(line), m.id).not.toMatch(SCORE);
    }
  });

  it("catches a score in any form, and lets the denial through", () => {
    for (const line of ["Scored by Inspector.", "Will score each token.", "A trust score.", "Scores every token.", "Scoring is done."]) {
      expect(withoutTheDenial(line), line).toMatch(SCORE);
    }
    expect(withoutTheDenial("Evidence, never a score.")).not.toMatch(SCORE);
  });

  it("gives Radar the words that say each new token comes with Inspector's checks", () => {
    const radar = APPS.find((m) => m.id === "radar");
    expect(radar?.blurb).toBe("New tokens, each with Inspector's checks");
    expect(radar?.details).toEqual([
      "Will list new tokens and locks on Arc as they appear.",
      "Will run Inspector's checks on each new token: evidence, never a score.",
      "Needs an index of new tokens first.",
    ]);
  });
});

describe("the no-dates rule", () => {
  it("catches a year, any month, and a quarter", () => {
    for (const line of ["Ships in 2027.", "Ships in January.", "Ships in May.", "Ships in December.", "Ships in Q3."]) {
      expect(line, line).toMatch(DATES);
    }
  });

  it("does not take the modal verb for the month", () => {
    for (const line of ["It may need an audit first.", "Will show what may be revoked."]) {
      expect(line, line).not.toMatch(DATES);
    }
  });
});
