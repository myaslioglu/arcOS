import { authDeps } from "@/lib/auth-deps";
import { nonceResponse } from "@/lib/auth-server";

// Answers { nonce }, stored for 10 minutes (lib/auth-server.ts). Every answer is no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return nonceResponse(req, authDeps());
}
