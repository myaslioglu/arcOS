import { badgeAnswer } from "@/lib/inspect-route";

// Rendered on every request: an inspection is live chain data, and the explorer key is a runtime-only secret.
export const dynamic = "force-dynamic";

/** GET /badge/<address>: Arc's badge, embedded on other sites, so this form stays Arc's for good. */
export async function GET(req: Request, ctx: { params: Promise<{ target: string }> }) {
  const { target } = await ctx.params;
  return badgeAnswer(req, "arc", target);
}
