/** Vault's control styles. Every control is at least 32px high, 44px on touch. */
export const BUTTON = "min-h-8 rounded-md border border-border-2 px-3 text-xs pointer-coarse:min-h-11 disabled:opacity-50";
/** A picked preset. */
export const PICKED = "border-accent bg-surface-2 text-accent-text";
/** Text fields: 16px text on a touch screen, so iOS doesn't zoom in when one is focused. */
export const INPUT =
  "min-h-8 w-full min-w-0 rounded-md border border-border-2 bg-surface px-2 font-mono text-xs pointer-coarse:min-h-11 pointer-coarse:text-base";
/** Date fields, beside the presets: the same height and the same 16px text on touch as INPUT. */
export const DATE_INPUT = "min-h-8 rounded-md border border-border-2 bg-surface px-2 text-xs pointer-coarse:min-h-11 pointer-coarse:text-base";
export const LINK = "text-accent-text underline";

/**
 * An invalid field says so (aria-invalid) and points at its message (aria-describedby), as Vesting's fields do. The
 * message's element carries the id `${id}-error`.
 */
export const invalid = (id: string, message: string | null | undefined) =>
  message ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
