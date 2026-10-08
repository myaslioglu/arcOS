import { NextResponse } from "next/server";
import { activeNetwork } from "@arcos/chain";
import { causeCode } from "@/lib/index-source";
import { radarAnswer, radarQuery } from "@/lib/radar";
import { radarFeedPage } from "@/lib/radar-server";
import { clientKey, rateLimiter } from "@/lib/rate-limit";

// Rendered on every request: the index changes every minute, and it is read with the server's own account.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One Radar window polls 3 times a minute; 60 leaves room for several tabs behind one address. */
const limiter = rateLimiter(60, 60_000);
const NO_STORE = { "cache-control": "no-store" };

/**
 * GET /api/radar?hasLiquidity=0|1&minPassed=0|5: the newest 50 tokens the indexer recorded on Arc mainnet for that
 * filter, newest first, each with Inspector's counts, its best pool's depth, where the index first saw it and its
 * launchpad badge, plus when the indexer last finished a run (`indexedAt`) and this server's own time as it answers
 * (`servedAt`, which the window measures the ages against). Page one only: `before` answers 400. Kept 20 s at the CDN.
 * The index holds mainnet data only, so on testnet this route is not there (404), and the Radar window says so.
 */
export async function GET(req: Request) {
  if (activeNetwork() !== "mainnet") return NextResponse.json({ error: "Not available on this network." }, { status: 404, headers: NO_STORE });
  const q = radarQuery(new URL(req.url).searchParams);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400, headers: NO_STORE });
  const decision = limiter.take(clientKey(req.headers));
  if (!decision.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSec), ...NO_STORE } },
    );
  }
  try {
    return NextResponse.json(radarAnswer(await radarFeedPage(q.filter)), { headers: { "cache-control": "public, s-maxage=20" } });
  } catch (e) {
    // The error's name, and the read's own error code when there is one (index-source.ts, IndexUnavailable): a Firestore
    // message can name the project and the database, so never the message. In the logs: `radar failed IndexUnavailable 7`
    // is PERMISSION_DENIED (the site's account lacks roles/datastore.user on the arcos database), 16 UNAUTHENTICATED, 5
    // NOT_FOUND; no code at all is the 1.5 s deadline, the 60 s cooldown after a failure, or a server with no Firestore.
    const code = causeCode(e);
    console.error("radar failed", e instanceof Error ? e.name : "unknown", ...(code === undefined ? [] : [code]));
    return NextResponse.json({ error: "The token index can't be read right now." }, { status: 503, headers: { "retry-after": "60", ...NO_STORE } });
  }
}
