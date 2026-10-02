import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { resolveDatabaseId } from "./database-id";

// A named app, so it never collides with an app another module initialises.
const APP_NAME = "arcos-data";

let handle: Firestore | undefined;

/**
 * The Firestore handle for the named database arcos. Server code only: it holds the Admin SDK, which needs credentials
 * the browser never has, so import "@arcos/data/server" from route handlers, server-only modules and functions, never
 * from a component that reaches the browser. The Admin app starts on the first call, with application default
 * credentials (the runtime's service account; against the emulator none are used), and every later call returns the
 * same handle.
 */
export function arcosDb(): Firestore {
  if (handle) return handle;
  const app =
    getApps().find((candidate) => candidate.name === APP_NAME) ??
    initializeApp({ credential: applicationDefault() }, APP_NAME);
  handle = getFirestore(app, resolveDatabaseId(process.env));
  return handle;
}

export { indexedPools } from "./pools";
