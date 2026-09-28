import { NextResponse } from "next/server";
import { cachedPulse } from "@/lib/pulse-server";

// Rendered on every request, never at build time: the answer is live chain data, kept in memory by pulse-server.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await cachedPulse(), { headers: { "cache-control": "public, max-age=30" } });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
