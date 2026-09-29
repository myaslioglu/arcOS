import { EVENT_PROPS, type EventName } from "./events";

/** An event that passed, with only the props that did. */
export type CountedEvent = { event: EventName; props: Record<string, string | number> };

const MAX_NUMBER = 1_000_000;
/** At most 32 characters of these: a chain's or a command's name fits, and an address (42 characters) doesn't. */
const LABEL = /^[A-Za-z0-9_.-]{1,32}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A prop's value if it is one the site counts: a whole number from 0 to 1,000,000, or a short label; else undefined. */
function cleanValue(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= MAX_NUMBER ? value : undefined;
  if (typeof value === "string") return LABEL.test(value) ? value : undefined;
  return undefined;
}

/**
 * What a POST to /api/event may count, from its parsed body `{ name, props }`, or null for nothing.
 *
 * Only a name in the event list counts. Of its props only its own are read, in the order the list gives them and only from
 * the props' own properties, so nothing comes down a prototype and nothing a client adds is passed on. A value that fails
 * is dropped, and the event is still counted. The body is a stranger's, so nothing in it is trusted to be what it says.
 */
export function validateEvent(body: unknown): CountedEvent | null {
  if (!isRecord(body)) return null;
  const { name } = body;
  if (typeof name !== "string" || !Object.hasOwn(EVENT_PROPS, name)) return null;
  const given = isRecord(body.props) ? body.props : {};
  const props: Record<string, string | number> = {};
  for (const key of EVENT_PROPS[name as EventName] as readonly string[]) {
    if (!Object.hasOwn(given, key)) continue;
    const value = cleanValue(given[key]);
    if (value !== undefined) props[key] = value;
  }
  return { event: name as EventName, props };
}

/**
 * Whether a request's `Origin` is the site's own. No Origin at all passes: a beacon from an old browser or a command line
 * sends none, and this is a courtesy against another site's page counting events here, not a lock. Any other Origin has to
 * be http or https with a host (and port) the site answers to: its `Host`, the host a proxy forwarded, or the address it is
 * configured with. The scheme isn't compared: the server can see http where the visitor used https.
 */
export function isOwnOrigin(origin: string | null, ownHosts: readonly (string | null | undefined)[]): boolean {
  if (origin === null) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.host.toLowerCase();
  return ownHosts.some((own) => typeof own === "string" && own !== "" && own.toLowerCase() === host);
}
