import { watchDeps } from "@/lib/watch-deps";
import { telegramWebhookResponse } from "@/lib/watch-server";

// What Telegram calls with the bot's updates, with the secret header setWebhook registered (lib/watch-server.ts). The
// reply rides in the response body. Every answer is no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return telegramWebhookResponse(req, watchDeps());
}
