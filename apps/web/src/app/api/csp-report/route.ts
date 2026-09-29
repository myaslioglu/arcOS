import { violationsFrom } from "@/lib/csp-report";
import { clientKey, rateLimiter } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/read-body";

// Where the browser posts what the report-only content security policy would have blocked (see lib/security-headers.ts).
// Rendered on every request; the answer is always the same.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Chromium puts the whole policy (about 1.4 KB) into every report, so a report is about 2 KB, and its cache holds up to
 * 100 reports for one upload: about 200 KB. The cap sits just above that. The body is read as a stream and given up on
 * at the cap, so a larger one costs no more memory than this (lib/read-body.ts).
 */
const MAX_BODY_BYTES = 256 * 1024;
// A page with a policy that doesn't fit raises one report for each thing it blocks, so a real visitor can send a
// handful in a burst. Each client gets 60 a minute (per server instance); the rest are dropped without a line.
const limiter = rateLimiter(60, 60_000);

/** Always this, whatever came in: a report is never answered with anything, so the endpoint tells a caller nothing. */
const done = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/**
 * Writes one line of JSON on stderr for each distinct violation in an `application/csp-report` or
 * `application/reports+json` body, at most ten for a request, in the shape Cloud Run reads as a structured log entry:
 * `severity` and `message`, then what was violated, the origin (or keyword) that was blocked, and the page's path. Nothing
 * else of the request or the report is logged: not the client's address, its user agent, a query string or the referrer.
 *
 * It always answers 204: a body that is too large, isn't JSON, has the wrong shape or type, a client over its limit, and
 * a report that is fine all look the same from outside.
 */
export async function POST(req: Request) {
  try {
    if (!limiter.take(clientKey(req.headers)).ok) return done();
    const text = await readBodyCapped(req, MAX_BODY_BYTES);
    if (text === null) return done();
    for (const { directive, blocked, path } of violationsFrom(req.headers.get("content-type") ?? "", JSON.parse(text))) {
      console.warn(JSON.stringify({ severity: "WARNING", message: "csp-violation", directive, blocked, path }));
    }
  } catch {
    // Not JSON, or the connection dropped mid-body: nothing to log, and nothing to say about it.
  }
  return done();
}
