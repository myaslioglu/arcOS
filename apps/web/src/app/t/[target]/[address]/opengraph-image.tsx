import { headers } from "next/headers";
import { ImageResponse } from "next/og";
import { cardCacheControl, cardLoad, routeChain, takePageTurn } from "@/lib/inspect-route";
import { ogCard } from "@/lib/og-card";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "ArcOS token report";
// Rendered on every request, as Arc's card is: see app/t/[target]/opengraph-image.tsx.
export const dynamic = "force-dynamic";

/**
 * The social card of /t/<chain>/<address>, off Arc: 404 where this site doesn't read the chain, and a neutral card with a
 * 429 once the client is past its turns (the same limiter as the page and the badge).
 */
export default async function Image({ params }: { params: Promise<{ target: string; address: string }> }) {
  const { target, address } = await params;
  const chain = routeChain(target);
  if (!chain) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const turn = takePageTurn(await headers());
  if (!turn.ok) {
    return new ImageResponse(ogCard(null, chain.name), { ...size, status: 429, headers: { "cache-control": "no-store", "retry-after": String(turn.retryAfterSec) } });
  }
  const load = await cardLoad(chain.key, address);
  return new ImageResponse(ogCard(load.report, chain.name), { ...size, headers: { "cache-control": cardCacheControl(load) } });
}
