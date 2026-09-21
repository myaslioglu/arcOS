import { describe, expect, it } from "vitest";
import { shouldEscapeCloseWindow } from "../escape";

describe("shouldEscapeCloseWindow", () => {
  it("closes the window for a plain Escape with no target", () => {
    expect(shouldEscapeCloseWindow({ defaultPrevented: false, target: null })).toBe(true);
  });

  it("closes the window when Escape lands on ordinary window chrome", () => {
    expect(shouldEscapeCloseWindow({ defaultPrevented: false, target: { tagName: "DIV" } })).toBe(true);
    expect(shouldEscapeCloseWindow({ defaultPrevented: false, target: { tagName: "BUTTON" } })).toBe(true);
  });

  it("never closes the window when an overlay already handled the key", () => {
    expect(shouldEscapeCloseWindow({ defaultPrevented: true, target: null })).toBe(false);
    expect(shouldEscapeCloseWindow({ defaultPrevented: true, target: { tagName: "DIV" } })).toBe(false);
  });

  it("never closes the window when the target is a text field", () => {
    expect(shouldEscapeCloseWindow({ defaultPrevented: false, target: { tagName: "input" } })).toBe(false);
    expect(shouldEscapeCloseWindow({ defaultPrevented: false, target: { tagName: "TEXTAREA" } })).toBe(false);
    expect(shouldEscapeCloseWindow({ defaultPrevented: false, target: { tagName: "SELECT" } })).toBe(false);
  });

  it("never closes the window when the target is directly contenteditable", () => {
    expect(
      shouldEscapeCloseWindow({ defaultPrevented: false, target: { tagName: "DIV", isContentEditable: true } }),
    ).toBe(false);
  });

  it("never closes the window when the target is inside a text field via closest()", () => {
    const span = { tagName: "SPAN", closest: (sel: string) => (sel.includes("input") ? {} : null) };
    expect(shouldEscapeCloseWindow({ defaultPrevented: false, target: span })).toBe(false);
  });

  it("closes the window when closest() finds nothing", () => {
    const span = { tagName: "SPAN", closest: () => null };
    expect(shouldEscapeCloseWindow({ defaultPrevented: false, target: span })).toBe(true);
  });
});
