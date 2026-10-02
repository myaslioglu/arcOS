/** How long a logged `details` may be. */
export const DETAILS_MAX = 200;

/** The error's name only: a node's or an explorer's message could carry its URL. */
export const nameOf = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/** A gRPC status code (0 to 16), as Firestore's errors carry it. */
const isGrpcCode = (code: unknown): code is number => typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 16;

/** A URL with a scheme, then a host and path without one (`node.example.com/v2/key`). */
const URL_WITH_SCHEME = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const HOST_AND_PATH = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S*/gi;
/** An address, or a longer hex id (a v4 pool id): doc ids such as `mainnet:0x…` carry them. */
const HEX_ID = /0x[0-9a-f]{40,}/gi;

/** `details` with every URL, host path and address replaced, cut to DETAILS_MAX characters. */
const maskDetails = (details: string): string =>
  details.replace(URL_WITH_SCHEME, "[url]").replace(HOST_AND_PATH, "[url]").replace(HEX_ID, "[address]").slice(0, DETAILS_MAX);

/**
 * What a log line may say about an error, never its message (a node's or an explorer's message could carry its URL):
 * - `error`, its name;
 * - `code`, for any error whose `code` is a number or a short string (a gRPC status, a JSON-RPC code, `ECONNRESET`);
 * - `details`, only for a gRPC-shaped error (a status code 0 to 16 and `metadata`, as Firestore's errors have), with
 *   URLs, host paths and addresses masked (log lines carry no address) and cut to DETAILS_MAX characters.
 */
export function errorFields(e: unknown): { error: string; code?: number | string; details?: string } {
  const fields: { error: string; code?: number | string; details?: string } = { error: nameOf(e) };
  if (typeof e !== "object" || e === null) return fields;
  const { code, details } = e as { code?: unknown; details?: unknown };
  if ((typeof code === "number" && Number.isFinite(code)) || (typeof code === "string" && /^[\w.-]{1,64}$/.test(code))) fields.code = code;
  // A viem error has `code` and `details` too (a JSON-RPC code, the node's own words), but no metadata, so its details
  // stay out.
  if (isGrpcCode(code) && "metadata" in e && typeof details === "string" && details !== "") fields.details = maskDetails(details);
  return fields;
}
