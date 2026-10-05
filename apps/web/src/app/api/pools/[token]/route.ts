import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { activeNetwork, type Address } from "@arcos/chain";
import { indexedPools } from "@/lib/indexed-pools-server";
import { causeCode, poolsAnswer } from "@/lib/indexed-pools";
import { clientKey, rateLimiter } from "@/lib/rate-limit";

// Rendered on every request: the index changes every minute, and it is read with the server's own account.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const limiter = rateLimiter(30, 60_000);
const NO_STORE = { "cache-control": "no-store" };

/**
 * GET /api/pools/[token]: the pools the indexer recorded for a token, v4 pool keys included, newest first, kept 60 s at
 * the CDN. The browser Inspector reads its `extraPools` from it. The index holds mainnet data only, so on testnet this
 * route is not there (404), and the Inspector reads that as "no indexed pools".
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (activeNetwork() !== "mainnet") return NextResponse.json({ error: "Not available on this network." }, { status: 404, headers: NO_STORE });
  const { token } = await ctx.params;
  if (!isAddress(token, { strict: false })) {
    return NextResponse.json({ error: "That isn't an address." }, { status: 400, headers: NO_STORE });
  }
  const decision = limiter.take(clientKey(req.headers));
  if (!decision.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSec), ...NO_STORE } },
    );
  }
  try {
    const docs = await indexedPools(token as Address);
    return NextResponse.json(poolsAnswer(docs), { headers: { "cache-control": "public, s-maxage=60" } });
  } catch (e) {
    // The error's name, and the read's own error code when there is one (indexed-pools.ts, IndexUnavailable): a Firestore
    // message can name the project and the database, so never the message. In the logs: `pools failed IndexUnavailable 7`
    // is PERMISSION_DENIED (the site's account lacks roles/datastore.user on the arcos database), 16 UNAUTHENTICATED, 5
    // NOT_FOUND; no code at all is the 1.5 s deadline, the 60 s cooldown after a failure, or a server with no Firestore.
    const code = causeCode(e);
    console.error("pools failed", e instanceof Error ? e.name : "unknown", ...(code === undefined ? [] : [code]));
    return NextResponse.json({ error: "The pool index can't be read right now." }, { status: 503, headers: { "retry-after": "60", ...NO_STORE } });
  }
}
