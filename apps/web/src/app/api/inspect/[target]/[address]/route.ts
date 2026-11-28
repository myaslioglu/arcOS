import { chainNotFound, inspectAnswer, routeChain } from "@/lib/inspect-route";

// Rendered on every request: an inspection is live chain data, and the keys are runtime-only secrets.
export const dynamic = "force-dynamic";

/**
 * GET /api/inspect/<chain>/<address>: the report on a chain other than Arc, where this site reads it, and 404 where it
 * doesn't. /api/inspect/arc/<address> is redirected to /api/inspect/<address> (next.config.ts) before it gets here.
 */
export async function GET(req: Request, ctx: { params: Promise<{ target: string; address: string }> }) {
  const { target, address } = await ctx.params;
  const chain = routeChain(target);
  return chain ? inspectAnswer(req, chain.key, address) : chainNotFound();
}
