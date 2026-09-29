import type { EventName } from "./events";

export type { EventName };

const ENDPOINT = "/api/event";

/**
 * Counts an event: sends `{ name, props }` to this site's own /api/event, which writes it to the host's logs (no cookie, no
 * third-party script). With `navigator.sendBeacon`, which the browser finishes even as the page goes away; if there is
 * none, or it won't queue the beacon, with a `fetch` that has `keepalive` for the same reason. Nothing at all while the
 * page renders on the server.
 *
 * Never lets counting break a user action: whatever goes wrong here, nothing is thrown and nothing is retried.
 */
export function trackEvent(name: EventName, props: Record<string, string | number> = {}): void {
  try {
    if (typeof window === "undefined") return;
    const body = JSON.stringify({ name, props });
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
      }
    } catch {
      // A beacon that throws is sent the other way.
    }
    void fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    // ignore
  }
}
