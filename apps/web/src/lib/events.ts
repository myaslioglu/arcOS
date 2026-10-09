/**
 * The events the site counts, each with the props it may carry and no others. The browser's helper (analytics.ts) and the
 * route that receives them (app/api/event) both read this list, so an event or a prop exists on both sides or on neither.
 * A prop is a whole number or a short label, never an address: see event-validation.ts for the rules on a value.
 */
export const EVENT_PROPS = {
  inspect_run: ["passed", "total"],
  fix_click: ["app"],
  proof_share: [],
  mint_success: ["mintable", "burnable"],
  drop_success: ["recipients", "batches"],
  swap_success: ["pair"],
  bridge_success: ["from", "to"],
  revoke_success: [],
  terminal_run: ["command"],
  /** Inspector's "Watch with Watchdog" button. */
  watch_click: [],
  /** A token watched, with the count of watches after the add. */
  watch_add: ["watches"],
  /** Telegram's link opened from Watchdog. */
  telegram_link: [],
} as const satisfies Record<string, readonly string[]>;

export type EventName = keyof typeof EVENT_PROPS;

export const EVENT_NAMES = Object.keys(EVENT_PROPS) as EventName[];
