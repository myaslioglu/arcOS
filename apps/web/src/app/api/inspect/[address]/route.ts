import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { NotAContract } from "@arcos/inspector";
import { cachedInspection } from "@/lib/inspect-server";

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!isAddress(address, { strict: false })) {
    return NextResponse.json({ error: "That isn't an address." }, { status: 400 });
  }
  try {
    const report = await cachedInspection(address);
    return NextResponse.json(report, {
      headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (e) {
    if (e instanceof NotAContract) return NextResponse.json({ error: "No contract at that address." }, { status: 404 });
    return NextResponse.json({ error: "Couldn't reach the network. Try again." }, { status: 502 });
  }
}
