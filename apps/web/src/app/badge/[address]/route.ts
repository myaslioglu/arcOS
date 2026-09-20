import { isAddress } from "viem";
import type { Address } from "@arcos/chain";
import { cachedInspection } from "@/lib/inspect-server";
import { badgeSvg } from "@/lib/proof";

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const report = isAddress(address, { strict: false }) ? await cachedInspection(address as Address).catch(() => null) : null;
  return new Response(badgeSvg(report), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, s-maxage=300, stale-while-revalidate=600" },
  });
}
