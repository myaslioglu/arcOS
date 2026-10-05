import "server-only";
import { acceptSignIn, isNonceLive, readSessionState, revokeSessions, storeNonce } from "@arcos/data/server";
import { signatureVerifier, type AuthDeps } from "./auth-server";
import { processGlobal } from "./process-global";
import { authRpcClient } from "./server-rpc";

/**
 * What the sign-in routes run on in the app: the Firestore store in the named database arcos (@arcos/data/server),
 * sign-in's own RPC client for smart-wallet signatures (authRpcClient(): its own endpoint health, CCIP-Read off), the
 * real clock and process.env. One per process.
 * The Admin SDK starts on the first store call, not here.
 */
export function authDeps(): AuthDeps {
  return processGlobal("auth.deps", () => ({
    store: { storeNonce, isNonceLive, acceptSignIn, readSessionState, revokeSessions },
    verifySignature: signatureVerifier(authRpcClient()),
    now: () => new Date(),
    env: process.env,
  }));
}
