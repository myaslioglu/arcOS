/**
 * One value per server process. Next bundles a server module into more than one chunk (the route handlers get one copy
 * of inspect-server.ts, the proof page another), each with its own module scope, so state kept in a module is kept once
 * per copy. They all share `globalThis`, though: a value kept there under a `Symbol.for` key is created once, by
 * whichever copy asks first, and every copy gets the same one.
 */
export function processGlobal<T>(name: string, create: () => T): T {
  const store = globalThis as typeof globalThis & Record<symbol, unknown>;
  const key = Symbol.for(`arcos.${name}`);
  if (!(key in store)) store[key] = create();
  return store[key] as T;
}
