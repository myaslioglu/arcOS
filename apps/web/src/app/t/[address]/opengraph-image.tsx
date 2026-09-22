import { ImageResponse } from "next/og";
import { isAddress } from "viem";
import type { Address } from "@arcos/chain";
import { NotAContract } from "@arcos/inspector";
import { InspectionTimeout, InspectorBusy, cachedInspection } from "@/lib/inspect-server";
import { ogCard } from "@/lib/og-card";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "4rcOS token report";
// Cached-by-default per next/og's route-segment-config behaviour; re-render at most every 5
// minutes so a badge doesn't go stale for the full life of a shared link.
export const revalidate = 300;

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const report = isAddress(address, { strict: false })
    ? await cachedInspection(address as Address).catch((e) => {
        // NotAContract (no token there), InspectorBusy and InspectionTimeout (both backpressure)
        // are expected outcomes, not failures worth an operator's attention.
        if (!(e instanceof NotAContract) && !(e instanceof InspectorBusy) && !(e instanceof InspectionTimeout)) {
          console.error("og inspect failed", address, e);
        }
        return null;
      })
    : null;
  return new ImageResponse(ogCard(report), size);
}
