/** How long a logged `details` may be. */
export const DETAILS_MAX = 200;

/** The error's name only: a node's or an explorer's message could carry its URL. */
export const nameOf = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/** A gRPC status code (0 to 16), as Firestore's errors carry it. */
const isGrpcCode = (code: unknown): code is number => typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 16;

/**
 * What a log line may say about an error: its name, its `code` when it is a number or a short string (a gRPC status, a
 * JSON-RPC code), and, for a gRPC-shaped error such as Firestore's, its `details` cut to DETAILS_MAX characters. Never the
 * message, which could carry a node's or an explorer's URL; and any URL in `details` is replaced, in case.
 */
export function errorFields(e: unknown): { error: string; code?: number | string; details?: string } {
  const fields: { error: string; code?: number | string; details?: string } = { error: nameOf(e) };
  if (typeof e !== "object" || e === null) return fields;
  const { code, details } = e as { code?: unknown; details?: unknown };
  if ((typeof code === "number" && Number.isFinite(code)) || (typeof code === "string" && /^[\w.-]{1,64}$/.test(code))) fields.code = code;
  // gRPC-shaped: a status code and metadata, as Firestore's errors have. A viem error has `code` and `details` too (a
  // JSON-RPC code, the node's own words), but no metadata, so its details stay out.
  if (isGrpcCode(code) && "metadata" in e && typeof details === "string" && details !== "") {
    fields.details = details.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").slice(0, DETAILS_MAX);
  }
  return fields;
}
