import { isAddress } from "viem";
import type { Address } from "@arcos/chain";
import { NotAContract } from "@arcos/inspector";
import { InspectorBusy, cachedInspection } from "@/lib/inspect-server";
import { badgeSvg } from "@/lib/proof";

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  let report = null;
  let inspectionFailed = false;
  if (isAddress(address, { strict: false })) {
    try {
      report = await cachedInspection(address as Address);
    } catch (e) {
      inspectionFailed = true;
      // NotAContract (no token there) and InspectorBusy (backpressure) are expected outcomes,
      // not failures worth an operator's attention.
      if (!(e instanceof NotAContract) && !(e instanceof InspectorBusy)) {
        console.error("badge inspect failed", address, e);
      }
    }
  }
  // A failed inspection (busy instance, network hiccup) isn't cached for five minutes like a
  // normal neutral badge — five seconds keeps the badge honest once capacity frees up.
  const cacheControl = inspectionFailed ? "public, s-maxage=5" : "public, s-maxage=300, stale-while-revalidate=600";
  return new Response(badgeSvg(report), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": cacheControl },
  });
}
