import { isAddress } from "viem";
import type { Address } from "@arcos/chain";
import { cachedInspection } from "@/lib/inspect-server";
import { isBusy, isNotAContract } from "@/lib/inspection-outcome";
import { badgeSvg } from "@/lib/proof";
import { FAILED_INSPECTION_CACHE_CONTROL, reportCacheControl } from "@/lib/report-cache";

// Rendered on every request: an inspection is live chain data, and the explorer key is a runtime-only secret.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  let report = null;
  let inspectionFailed = false;
  if (isAddress(address, { strict: false })) {
    try {
      report = await cachedInspection(address as Address);
    } catch (e) {
      inspectionFailed = true;
      // NotAContract (no token there), InspectorBusy and InspectionTimeout (both backpressure)
      // are expected outcomes, not failures worth an operator's attention.
      if (!isNotAContract(e) && !isBusy(e)) {
        console.error("badge inspect failed", e instanceof Error ? e.name : "unknown");
      }
    }
  }
  // A failed inspection (busy instance, network hiccup) isn't cached for five minutes like a
  // normal neutral badge — five seconds keeps the badge honest once capacity frees up. A degraded
  // report gets 30 seconds (see report-cache.ts).
  const cacheControl = inspectionFailed ? FAILED_INSPECTION_CACHE_CONTROL : reportCacheControl(report);
  return new Response(badgeSvg(report), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": cacheControl },
  });
}
