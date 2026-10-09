import { watchDeps } from "@/lib/watch-deps";
import { removeWatchResponse } from "@/lib/watch-server";

// Stops watching one token, named by the path (lib/watch-server.ts). Every answer is no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return removeWatchResponse(req, token, watchDeps());
}
