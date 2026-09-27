/**
 * Why an inspection ended without a report, told apart by the error's name rather than its class. The report cache
 * and the in-flight gate are shared by every bundled copy of inspect-server.ts in the process (see process-global.ts),
 * so the error a caller receives may have been thrown by another copy's class, and `instanceof` wouldn't recognise it.
 */
const named = (e: unknown, ...names: string[]): boolean => e instanceof Error && names.includes(e.name);

/** No contract at the address (the engine's `NotAContract`). */
export const isNotAContract = (e: unknown): boolean => named(e, "NotAContract");

/** Backpressure: this server process was already running its most inspections at once (`InspectorBusy`), or this one
 * ran out of time (`InspectionTimeout`). */
export const isBusy = (e: unknown): boolean => named(e, "InspectorBusy", "InspectionTimeout");
