import { NextResponse } from "next/server";
import { activeNetwork } from "@arcos/chain";
import { causeCode } from "@/lib/index-source";
import { clientKey, rateLimiter } from "@/lib/rate-limit";
import { statsNumbers } from "@/lib/stats-server";

// Rendered on every request: the answer is kept at the CDN for a minute by the header below, and read with the server's
// own account.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One Stats window polls once a minute; 60 leaves room for scripts and several tabs behind one address. */
const limiter = rateLimiter(60, 60_000);
/** The counts are public and carry no address, so any page may read them. */
const CORS = { "access-control-allow-origin": "*" };
const NO_STORE = { "cache-control": "no-store", ...CORS };

/**
 * GET /api/stats: how much ArcOS is used on Arc mainnet. Public, with CORS open to any origin. Each count says what it
 * counts, the date it counts from, whether it is `onchain` (anyone can recount it from the chain: `verify` names the
 * contracts, the event and an explorer link) or `server` (kept by ArcOS in its own data), plus the block the on-chain
 * counts are as of. Counts only: no address, no fee total. Kept 60 s at the CDN, and 5 minutes more while a fresh one is
 * fetched. The counter holds mainnet data only, so on testnet this route is not there (404), and the Stats window says so.
 */
export async function GET(req: Request) {
  if (activeNetwork() !== "mainnet") return NextResponse.json({ error: "Not available on this network." }, { status: 404, headers: NO_STORE });
  const decision = limiter.take(clientKey(req.headers));
  if (!decision.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSec), ...NO_STORE } },
    );
  }
  try {
    return NextResponse.json(await statsNumbers(), { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300", ...CORS } });
  } catch (e) {
    // The error's name, and the read's own error code when there is one (see /api/radar): never the message, which can
    // name the project and the database.
    const code = causeCode(e);
    console.error("stats failed", e instanceof Error ? e.name : "unknown", ...(code === undefined ? [] : [code]));
    return NextResponse.json({ error: "The usage counts can't be read right now." }, { status: 503, headers: { "retry-after": "60", ...NO_STORE } });
  }
}
