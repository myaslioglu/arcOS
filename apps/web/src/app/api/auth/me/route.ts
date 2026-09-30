import { authDeps } from "@/lib/auth-deps";
import { meResponse } from "@/lib/auth-server";

// Answers the signed-in wallet, or 401 (lib/auth-server.ts). Every answer is no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return meResponse(req, authDeps());
}
