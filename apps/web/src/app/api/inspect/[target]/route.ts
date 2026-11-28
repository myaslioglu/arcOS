import { inspectAnswer } from "@/lib/inspect-route";

// Rendered on every request: an inspection is live chain data, and the explorer key is a runtime-only secret.
export const dynamic = "force-dynamic";

/** GET /api/inspect/<address>: the report on Arc. A chain's own reports are at /api/inspect/<chain>/<address>. */
export async function GET(req: Request, ctx: { params: Promise<{ target: string }> }) {
  const { target } = await ctx.params;
  return inspectAnswer(req, "arc", target);
}
