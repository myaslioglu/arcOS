import "server-only";
import { acceptSignIn, readSessionState, revokeSessions, storeNonce } from "@arcos/data/server";
import { signatureVerifier, type AuthDeps } from "./auth-server";
import { processGlobal } from "./process-global";
import { serverRpcClient } from "./server-rpc";

/**
 * What the sign-in routes run on in the app: the Firestore store in the named database arcos (@arcos/data/server), the
 * server's RPC client for smart-wallet signatures (CCIP-Read off), the real clock and process.env. One per process.
 * The Admin SDK starts on the first store call, not here.
 */
export function authDeps(): AuthDeps {
  return processGlobal("auth.deps", () => ({
    store: { storeNonce, acceptSignIn, readSessionState, revokeSessions },
    verifySignature: signatureVerifier(serverRpcClient()),
    now: () => new Date(),
    env: process.env,
  }));
}
