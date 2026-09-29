import { validateEvent, isOwnOrigin } from "@/lib/event-validation";
import { clientKey, rateLimiter } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/read-body";

// Where the browser counts what visitors do (lib/analytics.ts). Rendered on every request; the answer is always the same.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** An event is a name and a few short props: well under 200 bytes. */
const MAX_BODY_BYTES = 2 * 1024;
// A visitor makes a few events in a session, and the Terminal one for each command typed. Each client gets 120 a minute
// (per server instance); the rest are not counted, and cost the client nothing else.
const limiter = rateLimiter(120, 60_000);

/** Always this, whatever came in: nothing is echoed, so the endpoint tells a caller nothing about what it took. */
const done = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** The names this site answers to, for the Origin check: the host it was asked for, the one a proxy forwarded, and its own. */
function ownHosts(req: Request): (string | null | undefined)[] {
  let site: string | undefined;
  try {
    site = process.env.NEXT_PUBLIC_SITE_URL ? new URL(process.env.NEXT_PUBLIC_SITE_URL).host : undefined;
  } catch {
    site = undefined;
  }
  return [req.headers.get("host"), req.headers.get("x-forwarded-host")?.split(",")[0]?.trim(), site];
}

/**
 * Counts one event by writing one line of JSON on stdout, in the shape Cloud Run reads as a structured log entry:
 * `severity`, `message`, the event's name, then its props. The name has to be in the event list and only its own props are
 * kept, each a whole number from 0 to 1,000,000 or a label of up to 32 letters, digits, dots, underscores and hyphens
 * (lib/event-validation.ts); a value that fails is dropped and the event still counts. Nothing else of the request is
 * logged: not the client's address, its user agent, its cookies, its referrer or its origin.
 *
 * It always answers 204. A body over 2 KB, a foreign Origin, a client over its limit, a name that isn't counted and an event
 * that is fine all look the same from outside. A request from another site is turned away before it costs the client any of
 * its allowance.
 */
export async function POST(req: Request) {
  try {
    if (!isOwnOrigin(req.headers.get("origin"), ownHosts(req))) return done();
    if (!limiter.take(clientKey(req.headers)).ok) return done();
    const text = await readBodyCapped(req, MAX_BODY_BYTES);
    if (text === null) return done();
    const counted = validateEvent(JSON.parse(text));
    if (counted) console.log(JSON.stringify({ severity: "INFO", message: "event", event: counted.event, ...counted.props }));
  } catch {
    // Not JSON, or the connection dropped mid-body: nothing to count, and nothing to say about it.
  }
  return done();
}
