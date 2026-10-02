/**
 * Bounds how long a single unit of work may run before the caller gives up waiting on it. Kept
 * in its own module (no "server-only", no live network client) so its timing behaviour can be
 * unit-tested with fake timers — inspect-server.ts, which does carry "server-only", composes it.
 */
export class InspectionTimeout extends Error {
  constructor() {
    super("The inspection took too long.");
    this.name = "InspectionTimeout";
  }
}

const DEADLINE_MS = 15_000;

/** Races `p` against `ms`. On timeout, `p` itself keeps running in the background — this only
 * makes the CALLER stop waiting on it, so whatever slot it was holding can free immediately — and
 * `controller`, when given, is aborted, so the parts of that work that listen to its signal (the
 * inspection's explorer requests) stop as well. */
export function withDeadline<T>(p: Promise<T>, controller?: AbortController, ms = DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new InspectionTimeout());
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}
