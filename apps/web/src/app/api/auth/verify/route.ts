import { authDeps } from "@/lib/auth-deps";
import { verifyResponse } from "@/lib/auth-server";

// Checks a signed sign-in message and sets the session cookie (lib/auth-server.ts). Every answer is no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return verifyResponse(req, authDeps());
}
