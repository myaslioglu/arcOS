import { track } from "@vercel/analytics";

export type EventName =
  | "inspect_run" | "fix_click" | "proof_share"
  | "mint_success" | "drop_success" | "swap_success" | "bridge_success";

/** Never lets analytics break a user action. */
export function trackEvent(name: EventName, props: Record<string, string | number> = {}): void {
  try {
    track(name, props);
  } catch {
    // ignore
  }
}
