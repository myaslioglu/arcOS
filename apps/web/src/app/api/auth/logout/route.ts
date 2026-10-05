import { authDeps } from "@/lib/auth-deps";
import { logoutResponse } from "@/lib/auth-server";

// Ends the wallet's sessions and clears the cookie (lib/auth-server.ts). Every answer is no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return logoutResponse(req, authDeps());
}
