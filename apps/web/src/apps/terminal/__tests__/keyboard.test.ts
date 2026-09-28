import { describe, expect, it } from "vitest";
import { shouldFocusOnClick, shouldInterceptTab } from "../keyboard";

describe("shouldFocusOnClick", () => {
  it("focuses when nothing is selected", () => {
    expect(shouldFocusOnClick(null)).toBe(true);
    expect(shouldFocusOnClick(undefined)).toBe(true);
  });

  it("focuses when the selection is collapsed (a plain click)", () => {
    expect(shouldFocusOnClick({ isCollapsed: true })).toBe(true);
  });

  it("doesn't focus when a real range is selected, so it can be copied", () => {
    expect(shouldFocusOnClick({ isCollapsed: false })).toBe(false);
  });
});

describe("shouldInterceptTab", () => {
  it("lets Shift+Tab through always", () => {
    expect(shouldInterceptTab(true, [])).toBe(false);
    expect(shouldInterceptTab(true, ["help"])).toBe(false);
  });

  it("lets Tab through when there is nothing to complete", () => {
    expect(shouldInterceptTab(false, [])).toBe(false);
  });

  it("intercepts Tab when there is something to complete", () => {
    expect(shouldInterceptTab(false, ["help"])).toBe(true);
    expect(shouldInterceptTab(false, ["help", "history"])).toBe(true);
  });
});
