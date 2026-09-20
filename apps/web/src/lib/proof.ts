import type { Report } from "@arcos/inspector";
import { shortAddress } from "./format";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const tokenLabel = (r: Report): string => r.token.symbol ?? shortAddress(r.address);

export function summaryLine(r: Report): string {
  return `${tokenLabel(r)} on Arc — ${r.passed} of ${r.total} checks pass`;
}

/** Token names and symbols are attacker-controlled. Everything that reaches the SVG is escaped. */
export function badgeSvg(r: Report | null): string {
  const left = r ? esc(tokenLabel(r).slice(0, 16)) : "ARC.os";
  const right = r ? `${r.passed}/${r.total} checks` : "not inspected";
  const ratio = r && r.total > 0 ? r.passed / r.total : 0;
  const color = !r ? "#6b6f79" : ratio >= 0.75 ? "#0c8a4e" : ratio >= 0.5 ? "#b97309" : "#b42318";
  const lw = 12 + left.length * 7;
  const rw = 12 + right.length * 7;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="22" role="img" aria-label="${left}: ${right}">` +
    `<rect width="${lw}" height="22" rx="4" fill="#14161c"/>` +
    `<rect x="${lw - 4}" width="${rw + 4}" height="22" rx="4" fill="${color}"/>` +
    `<g fill="#fff" font-family="Verdana,Geneva,sans-serif" font-size="11">` +
    `<text x="6" y="15">${left}</text><text x="${lw + 4}" y="15">${right}</text></g></svg>`
  );
}
