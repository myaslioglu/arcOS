/** The bits of a keydown event `shouldEscapeCloseWindow` needs — small enough to fake in a test
 * without a DOM, and structurally satisfied by a real `KeyboardEvent`. */
export type EscapeLikeTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};
export type EscapeLikeEvent = {
  defaultPrevented: boolean;
  target: EscapeLikeTarget | null;
};

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const FIELD_SELECTOR = "input, textarea, select, [contenteditable]";

/**
 * Whether an Escape keydown reaching the window frame (bubbled or, for the active window, observed
 * directly) should close it. False when an overlay already handled the key (Launcher, a menu, a
 * context menu all call `preventDefault`/`stopPropagation` on their own Escape handling — see
 * `defaultPrevented`), and false when the key is aimed at text entry (typing Escape to dismiss
 * autofill in an input, textarea, select or a contenteditable region must not also close the
 * window behind it).
 */
export function shouldEscapeCloseWindow(e: EscapeLikeEvent): boolean {
  if (e.defaultPrevented) return false;
  const target = e.target;
  if (!target) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag && TEXT_TAGS.has(tag)) return false;
  if (target.isContentEditable) return false;
  if (target.closest?.(FIELD_SELECTOR)) return false;
  return true;
}
