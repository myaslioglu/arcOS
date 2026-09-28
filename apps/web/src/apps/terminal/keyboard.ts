/**
 * Whether a click on the terminal should refocus the input. A click that ends a drag-select leaves a
 * non-collapsed selection; refocusing then would collapse it before it could be copied, so this says
 * no exactly then. A plain click, or nothing selected, still focuses as before.
 */
export function shouldFocusOnClick(selection: Pick<Selection, "isCollapsed"> | null | undefined): boolean {
  return selection?.isCollapsed !== false;
}

/**
 * Whether Tab (or Shift+Tab) should be intercepted for completion. Shift+Tab always passes through to
 * the browser, so keyboard users can tab backward; plain Tab passes through too when there's nothing
 * to complete, so they can reach the next focusable element — an explorer link a command printed, for
 * example.
 */
export function shouldInterceptTab(shiftKey: boolean, matches: readonly string[]): boolean {
  return !shiftKey && matches.length > 0;
}
