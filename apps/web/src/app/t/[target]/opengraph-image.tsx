import { ImageResponse } from "next/og";
import { cardCacheControl, cardLoad } from "@/lib/inspect-route";
import { ogCard } from "@/lib/og-card";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "ArcOS token report";
// Rendered on every request, like the badge: a card drawn from a degraded report mustn't be kept for 5 minutes by
// Next's own cache. How long a CDN may keep it is the cache-control header below, the same as the badge's.
export const dynamic = "force-dynamic";

/** The social card of /t/<address>, on Arc. */
export default async function Image({ params }: { params: Promise<{ target: string }> }) {
  const { target } = await params;
  const load = await cardLoad("arc", target);
  return new ImageResponse(ogCard(load.report), { ...size, headers: { "cache-control": cardCacheControl(load) } });
}
