import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { NotAContract } from "@arcos/inspector";
import { InspectionTimeout, InspectorBusy, cachedInspection } from "@/lib/inspect-server";
import { clientKey, rateLimiter } from "@/lib/rate-limit";

// Rendered on every request: an inspection is live chain data, and the explorer key is a runtime-only secret.
export const dynamic = "force-dynamic";

const limiter = rateLimiter(30, 60_000);

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!isAddress(address, { strict: false })) {
    return NextResponse.json({ error: "That isn't an address." }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  const decision = limiter.take(clientKey(req.headers));
  if (!decision.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSec), "cache-control": "no-store" } },
    );
  }

  try {
    const report = await cachedInspection(address);
    return NextResponse.json(report, {
      headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (e) {
    if (e instanceof NotAContract) return NextResponse.json({ error: "No contract at that address." }, { status: 404 });
    if (e instanceof InspectorBusy || e instanceof InspectionTimeout) {
      return NextResponse.json(
        { error: "Inspector is busy. Try again in a few seconds." },
        { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } },
      );
    }
    console.error("inspect failed", address, e);
    return NextResponse.json(
      { error: "Couldn't reach the network. Try again." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
