import { watchDeps } from "@/lib/watch-deps";
import { addWatchResponse, listWatchesResponse } from "@/lib/watch-server";

// The signed-in wallet's watch list: GET lists it, POST { token } adds to it (lib/watch-server.ts). Every answer is no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return listWatchesResponse(req, watchDeps());
}

export async function POST(req: Request) {
  return addWatchResponse(req, watchDeps());
}
