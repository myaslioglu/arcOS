import { watchDeps } from "@/lib/watch-deps";
import { linkTelegramResponse, unlinkTelegramResponse } from "@/lib/watch-server";

// The signed-in wallet's Telegram chat: POST makes a t.me link with a fresh code, DELETE takes the chat away
// (lib/watch-server.ts). Every answer is no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return linkTelegramResponse(req, watchDeps());
}

export async function DELETE(req: Request) {
  return unlinkTelegramResponse(req, watchDeps());
}
