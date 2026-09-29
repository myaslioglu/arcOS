import { ImageResponse } from "next/og";
import { isAddress } from "viem";
import type { Address } from "@arcos/chain";
import type { Report } from "@arcos/inspector";
import { cachedInspection } from "@/lib/inspect-server";
import { isBusy, isNotAContract } from "@/lib/inspection-outcome";
import { ogCard } from "@/lib/og-card";
import { FAILED_INSPECTION_CACHE_CONTROL, reportCacheControl } from "@/lib/report-cache";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "4rc.OS token report";
// Rendered on every request, like the badge: a card drawn from a degraded report mustn't be kept for 5 minutes by
// Next's own cache. How long a CDN may keep it is the cache-control header below, the same as the badge's.
export const dynamic = "force-dynamic";

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  let report: Report | null = null;
  let inspectionFailed = false;
  if (isAddress(address, { strict: false })) {
    try {
      report = await cachedInspection(address as Address);
    } catch (e) {
      inspectionFailed = true;
      // NotAContract (no token there), InspectorBusy and InspectionTimeout (both backpressure)
      // are expected outcomes, not failures worth an operator's attention.
      if (!isNotAContract(e) && !isBusy(e)) {
        console.error("og inspect failed", e instanceof Error ? e.name : "unknown");
      }
    }
  }
  const cacheControl = inspectionFailed ? FAILED_INSPECTION_CACHE_CONTROL : reportCacheControl(report);
  return new ImageResponse(ogCard(report), { ...size, headers: { "cache-control": cacheControl } });
}
