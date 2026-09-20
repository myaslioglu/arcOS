import type { Report } from "@arcos/inspector";
import { shortAddress } from "./format";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const tokenLabel = (r: Report): string => r.token.symbol ?? shortAddress(r.address);

export function summaryLine(r: Report): string {
  return `${tokenLabel(r)} on Arc — ${r.passed} of ${r.total} checks pass`;
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
 * Token names and symbols are attacker-controlled. Box widths are computed from the VISIBLE
 * text (sliced, unescaped) so a string of markup-heavy characters can't inflate the badge on
 * an embedding page; everything that reaches the SVG markup is escaped at the point it's
 * interpolated. The badge has no room for the project's disclaimer as visible text, so it
 * carries it in a <title> (read by tooltips and screen readers) and in aria-label.
 */
export function badgeSvg(r: Report | null): string {
  const left = r ? shortLabel(tokenLabel(r), 16) : "ARC.os";
  const right = r ? `${r.passed}/${r.total} checks` : "not inspected";
  const title = r ? `${left}: ${right} — automated analysis, not investment advice` : `${left}: ${right}`;
  const ratio = r && r.total > 0 ? r.passed / r.total : 0;
  const color = !r ? "#6b6f79" : ratio >= 0.75 ? "#0c8a4e" : ratio >= 0.5 ? "#b97309" : "#b42318";
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
