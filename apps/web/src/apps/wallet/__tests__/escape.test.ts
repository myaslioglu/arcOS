import { describe, expect, it } from "vitest";
import { shouldEscapeCloseWindow } from "@arcos/shell/core";
import { holdEscape } from "../escape";

/** A keydown as far as holdEscape and the shell's decision can see one. These tests run without a DOM. */
function keydown(key: string) {
  return Object.assign(new Event("keydown", { cancelable: true }), { key });
}

/** What the shell's window frame asks of an Escape that reaches it (packages/shell/src/ui/WindowFrame.tsx). */
const shellClosesWindow = (e: Event) => shouldEscapeCloseWindow({ defaultPrevented: e.defaultPrevented, target: null });

// The WalletConnect modal closes on Escape, and so does the shell's window frame, which acts first: the Wallet window would
// close under the modal and take the "cancelled" sentence with it. holdEscape marks the key handled, which the shell respects,
// and the modal ignores.
describe("holdEscape", () => {
  it("keeps the shell from closing the window on Escape", () => {
    const target = new EventTarget();
    const unheld = keydown("Escape");
    target.dispatchEvent(unheld);
    expect(shellClosesWindow(unheld), "without holdEscape the shell closes it").toBe(true);

    const release = holdEscape(target);
    const held = keydown("Escape");
    target.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    expect(shellClosesWindow(held)).toBe(false);
    release();
  });

  it("leaves every other key alone", () => {
    const target = new EventTarget();
    const release = holdEscape(target);
    for (const key of ["Enter", "Tab", " ", "a", "Backspace"]) {
      const event = keydown(key);
      target.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(false);
    }
    release();
  });

  it("stops holding Escape once it is released", () => {
    const target = new EventTarget();
    holdEscape(target)();
    const event = keydown("Escape");
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(shellClosesWindow(event)).toBe(true);
  });

  // The shell listens on the document as the key bubbles up. Only a listener that runs first, in the capture phase, can
  // mark the key handled before it does. A plain listener would look the same in every other test here.
  it("listens in the capture phase, and removes exactly what it added", () => {
    const calls: unknown[][] = [];
    const target = {
      addEventListener: (...args: unknown[]) => calls.push(["add", ...args]),
      removeEventListener: (...args: unknown[]) => calls.push(["remove", ...args]),
    } as unknown as EventTarget;
    holdEscape(target)();
    const [added, removed] = calls;
    expect(added).toEqual(["add", "keydown", expect.any(Function), { capture: true }]);
    expect(removed).toEqual(["remove", "keydown", added?.[2], { capture: true }]);
  });
});
