import type { Finding, Report } from "@arcos/inspector";
import { shortAddress } from "./format";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const tokenLabel = (r: Report): string => r.token.symbol ?? shortAddress(r.address);

/** "5 of 8 checks pass" — with an explicit unknown clause whenever there is one to show, so a
 * gap in the evidence is never silently folded into "not pass". */
export function passLine(r: Pick<Report, "counts" | "total">): string {
  const base = `${r.counts.pass} of ${r.total} checks pass`;
  return r.counts.unknown > 0 ? `${base} · ${r.counts.unknown} couldn't be checked` : base;
}

export function summaryLine(r: Report): string {
  return `${tokenLabel(r)} on Arc — ${passLine(r)}`;
}

/** Slices by Unicode code point, not UTF-16 code unit, so a surrogate pair (e.g. an emoji) is never split in half. */
export function shortLabel(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

export function readAtLine(r: Report): string {
  const at = r.blockNumber === "unknown" ? "Read at an unknown block" : `Read at block ${r.blockNumber}`;
  return `${at} · ${r.generatedAt.slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Colour is driven by fails and warns only — `unknown` (missing evidence) must never read as a
 * failure. Grey only kicks in once unknowns dominate (3 or more) with nothing worse found, so a
 * report that's mostly "couldn't be checked" doesn't look as clean as an all-green one.
 */
export function badgeColor(counts: Report["counts"] | null): string {
  if (!counts) return "#6b6f79";
  if (counts.fail > 0) return "#b42318";
  if (counts.warn > 0) return "#b97309";
  if (counts.unknown >= 3) return "#6b6f79";
  return "#0c8a4e";
}

/**
 * Token names and symbols are attacker-controlled. Box widths are computed from the VISIBLE
 * text (sliced, unescaped) so a string of markup-heavy characters can't inflate the badge on
 * an embedding page; everything that reaches the SVG markup is escaped at the point it's
 * interpolated. The badge has no room for the project's disclaimer (or the explorer-down fact)
 * as visible text, so both are carried in a <title> (read by tooltips and screen readers) and in
 * aria-label; the visible right-hand cell stays short ("5/8 pass", or "5/8 pass · 3 ?" when some
 * checks are unknown).
 */
export function badgeSvg(r: Report | null): string {
  const left = r ? shortLabel(tokenLabel(r), 16) : "ARC.os";
  const right = r
    ? r.counts.unknown > 0
      ? `${r.counts.pass}/${r.total} pass · ${r.counts.unknown} ?`
      : `${r.counts.pass}/${r.total} pass`
    : "not inspected";
  const disclaimer = r ? " — automated analysis, not investment advice" : "";
  const explorerNote = r && !r.explorerReachable ? " — the explorer didn't answer some checks" : "";
  const title = `${left}: ${right}${disclaimer}${explorerNote}`;
  const color = badgeColor(r ? r.counts : null);
  const lw = 12 + left.length * 7;
  const rw = 12 + right.length * 7;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="22" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title>` +
    `<rect width="${lw}" height="22" rx="4" fill="#14161c"/>` +
    `<rect x="${lw - 4}" width="${rw + 4}" height="22" rx="4" fill="${color}"/>` +
    `<g fill="#fff" font-family="Verdana,Geneva,sans-serif" font-size="11">` +
    `<text x="6" y="15">${esc(left)}</text><text x="${lw + 4}" y="15">${esc(right)}</text></g></svg>`
  );
}

const FINDING_RANK: Record<Finding["status"], number> = { fail: 0, warn: 1, unknown: 2, pass: 3 };

/**
 * Worst-first ranking for a surface (the OG card) that can only show a handful of findings.
 * A stable sort (native `Array.sort` since ES2019) keeps same-rank findings in their original,
 * already-meaningful `ORDER` from the engine.
 */
export function rankFindings(findings: Finding[], limit = 4): { shown: Finding[]; hiddenCount: number } {
  const sorted = [...findings].sort((a, b) => FINDING_RANK[a.status] - FINDING_RANK[b.status]);
  return { shown: sorted.slice(0, limit), hiddenCount: Math.max(0, sorted.length - limit) };
}
