import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { cachedInspection } from "@/lib/inspect-server";
import { isBusy, isNotAContract } from "@/lib/inspection-outcome";
import { clientKey, rateLimiter } from "@/lib/rate-limit";
import { reportCacheControl } from "@/lib/report-cache";

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
    return NextResponse.json(report, { headers: { "cache-control": reportCacheControl(report) } });
  } catch (e) {
    if (isNotAContract(e)) return NextResponse.json({ error: "No contract at that address." }, { status: 404 });
    if (isBusy(e)) {
      return NextResponse.json(
        { error: "Inspector is busy. Try again in a few seconds." },
        { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } },
      );
    }
    // The error's name only, the way the approvals and pulse routes log: a node's or an explorer's message could carry
    // its URL.
    console.error("inspect failed", e instanceof Error ? e.name : "unknown");
    return NextResponse.json(
      { error: "Couldn't reach the network. Try again." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
