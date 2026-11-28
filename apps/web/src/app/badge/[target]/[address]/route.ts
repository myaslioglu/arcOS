import { badgeAnswer, chainNotFound, routeChain } from "@/lib/inspect-route";

// Rendered on every request: an inspection is live chain data, and the keys are runtime-only secrets.
export const dynamic = "force-dynamic";

/**
 * GET /badge/<chain>/<address>: the badge on a chain other than Arc, where this site reads it, and 404 where it doesn't.
 * /badge/arc/<address> is redirected to /badge/<address> (next.config.ts) before it gets here.
 */
export async function GET(req: Request, ctx: { params: Promise<{ target: string; address: string }> }) {
  const { target, address } = await ctx.params;
  const chain = routeChain(target);
  return chain ? badgeAnswer(req, chain.key, address) : chainNotFound();
}
