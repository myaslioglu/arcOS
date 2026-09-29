import { readFileSync } from "node:fs";
import path from "node:path";
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

/**
 * A source scan: the "Tab: <word>" hint reads `atEnd`. onChange resyncs it from the real caret, but a value set from code
 * (history, a completion, a cleared line) fires no event, so those sets go through setInputFromCode, which also says the
 * caret is at the end. There is no DOM to mount the window in and press keys, so this pins that no set from code can
 * skip it: setInput( is called directly only by onChange, and by that helper.
 */
describe("Window.tsx sets the input from code only through setInputFromCode", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "Window.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const helper = source.match(/const setInputFromCode = \(value: string\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  const rest = source.replace(helper, "");

  it("has the helper set the value and then the caret's place", () => {
    expect(helper, "setInputFromCode").not.toBe("");
    expect(helper).toMatch(/setInput\(value\);\s*setAtEnd\(true\);/);
  });

  it("calls setInput( directly only in onChange, which resyncs from the real caret", () => {
    expect([...rest.matchAll(/\bsetInput\(/g)]).toHaveLength(1);
    const onChange = rest.match(/onChange=\{\(e\) => \{([\s\S]*?)\n\s*\}\}/)?.[1] ?? "";
    expect(onChange).toContain("setInput(e.target.value)");
    expect(onChange).toContain("syncCaret(e.target)");
  });

  it("has every key handler that changes the line use the helper", () => {
    const keyDown = rest.slice(rest.indexOf("const onKeyDown"), rest.indexOf("return (\n    <div"));
    expect(keyDown).not.toBe("");
    expect(keyDown).not.toMatch(/\bsetInput\(/);
    expect(keyDown).toMatch(/setInputFromCode\(/);
  });
});
