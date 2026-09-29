import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { cachedApprovals } from "@/lib/approvals-server";
import { clientKey, rateLimiter } from "@/lib/rate-limit";

// Rendered on every request: the answer is live chain data, and the explorer key is a runtime-only secret.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A lookup can read five explorer pages and a multicall, so each client gets 20 a minute (per server instance).
const limiter = rateLimiter(20, 60_000);
const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isAddress(owner, { strict: false })) {
    return NextResponse.json({ error: "That isn't an address." }, { status: 400, headers: NO_STORE });
  }
  const decision = limiter.take(clientKey(req.headers));
  if (!decision.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(decision.retryAfterSec) } },
    );
  }
  try {
    // no-store: the server keeps each owner's answer for 60 s; a CDN copy would outlive a revoke.
    return NextResponse.json(await cachedApprovals(getAddress(owner)), { headers: NO_STORE });
  } catch (e) {
    // The error's name only: an explorer's or a node's message is never logged whole (the key is never in one anyway).
    console.error("approvals failed", e instanceof Error ? e.name : "unknown");
    return NextResponse.json({ error: "Couldn't load approvals. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
}
