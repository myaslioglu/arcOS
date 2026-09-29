/**
 * What /api/csp-report takes from a browser's content security policy violation report, in the two shapes browsers send:
 *
 * - `application/csp-report` (report-uri): one violation as `{"csp-report": {"document-uri": …, "blocked-uri": …, …}}`.
 * - `application/reports+json` (report-to, the Reporting API): an array of reports, of which `type: "csp-violation"` are
 *   ours, each with the fields under `body` (`documentURL`, `blockedURL`, `effectiveDirective`, …).
 *
 * Only three things leave this module, each cut down to what a person reading the log needs: the directive that was
 * violated, what was blocked (an origin, or the keyword a browser gives in place of a URL) and the page's path. Anything
 * else in a report is never read into a value the caller could log: the query and fragment of a URL, the referrer, the
 * source file, the code sample, the user agent. Everything here comes from a stranger's request, so each value is
 * checked against a small shape and bounded, and a value that doesn't fit becomes "unknown" or "other" rather than
 * being passed on.
 */
export type Violation = { directive: string; blocked: string; path: string };

/**
 * A request's cap on distinct violations: a page with a broken policy can raise many in one batch. A violation counts once
 * however often the batch repeats it (see `fromReportsJson`), so one noisy host can't use up the cap and hide the rest.
 */
const MAX_PER_REQUEST = 10;
/** The reports of an array that are looked at: Chromium keeps at most 100 for one upload, so what follows isn't a browser's. */
const MAX_EXAMINED = 100;
const MAX_LENGTH = 200;
const DIRECTIVE = /^[a-z][a-z-]{0,39}$/;
const KEYWORD = /^[a-z][a-z0-9-]{0,31}$/;
/** A full address. A visitor may have looked up their own wallet, which the log isn't there to keep. */
const ADDRESS = /0x[0-9a-fA-F]{40}/g;
const WEB_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The directive's name: the first word of what a browser sent, when that is shaped like one. */
export function directiveOf(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const first = value.trim().split(/\s+/)[0]!.toLowerCase();
  return DIRECTIVE.test(first) ? first : "unknown";
}

/**
 * What was blocked. A web URL is cut to its origin, so its path, query, fragment and credentials are gone, and any full
 * address left in the origin (a host label can be one) is replaced, as it is in a path. A keyword a browser gives instead
 * of a URL (`inline`, `eval`, `wasm-eval`, `data`, `blob`, …) is kept. Any other scheme (a data: or blob: URL, a browser
 * extension's) is reduced to its name.
 */
export function blockedOf(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const text = value.trim();
  if (text === "") return "unknown";
  let url: URL | null = null;
  try {
    url = new URL(text);
  } catch {
    // Not a URL: a keyword such as `inline`, or nothing this log wants.
  }
  if (url) {
    // The address goes before the cut: a cut in the middle of one would leave half of it.
    if (WEB_SCHEMES.has(url.protocol)) return url.origin.replace(ADDRESS, "[address]").slice(0, MAX_LENGTH);
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    return KEYWORD.test(scheme) ? scheme : "other";
  }
  const keyword = text.toLowerCase();
  return KEYWORD.test(keyword) ? keyword : "other";
}

/** The document's pathname alone, never its query or fragment, with any full address in it replaced. */
export function pathOf(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "unknown";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
  return url.pathname.replace(ADDRESS, "[address]").slice(0, MAX_LENGTH);
}

const firstKnown = (...values: string[]): string => values.find((v) => v !== "unknown") ?? "unknown";

/** A violation with nothing usable in it is noise, not a report. */
const usable = (v: Violation): boolean => v.directive !== "unknown" || v.blocked !== "unknown" || v.path !== "unknown";

function fromCspReport(body: unknown): Violation[] {
  if (!isRecord(body)) return [];
  const report = body["csp-report"];
  if (!isRecord(report)) return [];
  const violation: Violation = {
    directive: firstKnown(directiveOf(report["effective-directive"]), directiveOf(report["violated-directive"])),
    blocked: blockedOf(report["blocked-uri"]),
    path: pathOf(report["document-uri"]),
  };
  return usable(violation) ? [violation] : [];
}

/**
 * Chromium sends one report for each thing a page is stopped from loading, all in one array, and a page whose policy
 * doesn't fit raises the same violation many times (28 font files from one host are 28 reports). What is logged is a
 * violation's directive, blocked origin and path, so the reports that agree on all three are one violation: it is read
 * once, in the place it first appears, and only distinct violations count towards the cap. Only the first
 * `MAX_EXAMINED` reports are looked at, which bounds the work a body of many tiny ones can cause.
 */
function fromReportsJson(body: unknown): Violation[] {
  if (!Array.isArray(body)) return [];
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const report of body.slice(0, MAX_EXAMINED)) {
    if (out.length >= MAX_PER_REQUEST) break;
    if (!isRecord(report) || report.type !== "csp-violation") continue;
    const fields = isRecord(report.body) ? report.body : {};
    const violation: Violation = {
      directive: firstKnown(directiveOf(fields.effectiveDirective), directiveOf(fields.violatedDirective)),
      blocked: blockedOf(fields.blockedURL),
      path: firstKnown(pathOf(fields.documentURL), pathOf(report.url)),
    };
    if (!usable(violation)) continue;
    const key = JSON.stringify([violation.directive, violation.blocked, violation.path]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(violation);
  }
  return out;
}

/** The violations in a parsed body, by the request's content type as the header sends it. Any other type reads nothing. */
export function violationsFrom(contentType: string, body: unknown): Violation[] {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "application/csp-report") return fromCspReport(body);
  if (type === "application/reports+json") return fromReportsJson(body);
  return [];
}
