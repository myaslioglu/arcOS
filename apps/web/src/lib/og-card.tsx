import type { Report } from "@arcos/inspector";
import { NAME_DISCLOSURE, passLine, rankFindings, shortLabel, tokenLabel } from "./proof";

/**
 * next/og's default font is missing glyphs for U+2713 (✓) and U+2717 (✗) — they render as
 * tofu boxes. ✔ (U+2714) and a plain ASCII "X" are both present, so this set differs from the
 * page's own MARK (which renders as HTML and has full system-font fallback).
 */
const MARK = { pass: "✔", warn: "!", fail: "X", unknown: "?" } as const;
const TINT = { pass: "#0c8a4e", warn: "#b97309", fail: "#b42318", unknown: "#6b6f79" } as const;

/**
 * The whole card as a function of the report, so its worst case — explorer unreachable, a long
 * symbol, every row a different status — can be rendered and LOOKED at without a server.
 *
 * The card is a fixed 1200x630 box, and overflowing it doesn't just cut the bottom off: satori
 * shrinks the overflowing children, so the symbol, the pass line and the explorer note collapse
 * into each other and overlap. The thing that goes first is the footer — the disclosure that this
 * name was chosen by whoever deployed the contract.
 *
 * The budget is 630 minus 2x48 padding = 534px, spent by: kicker 31 · symbol 77+12 · pass line
 * 48+4 · explorer note 27+6 · three rows at 46 plus "+N more" at 46, 24 above them · footer 16+27
 * and the disclosure at 22+4. That comes to ~482 WITH the explorer note, which is the normal case
 * for the server run on mainnet, where the explorer is behind a bot check. Three rows (not four)
 * is most of what buys the room; `rankFindings` puts the worst findings in them, so what the
 * "+N more" hides is never the worst news.
 */
export function ogCard(report: Report | null) {
  const { shown: rows, hiddenCount } = report ? rankFindings(report.findings, 3) : { shown: [], hiddenCount: 0 };
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: 48, background: "#f6f7f9", color: "#14161c", fontSize: 30 }}>
      <div style={{ display: "flex", fontSize: 26, color: "#555a66" }}>ARC.os · token report on Arc</div>
      <div style={{ display: "flex", fontSize: 64, marginTop: 12 }}>{report ? shortLabel(tokenLabel(report), 16) : "Token not found"}</div>
      {report && <div style={{ display: "flex", fontSize: 40, marginTop: 4 }}>{passLine(report)}</div>}
      {report && !report.explorerReachable && (
        <div style={{ display: "flex", fontSize: 22, marginTop: 6, color: "#6b6f79" }}>The explorer didn&apos;t answer some checks.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 24 }}>
        {rows.map((f) => (
          <div key={f.id} style={{ display: "flex", marginTop: 10 }}>
            <div style={{ display: "flex", width: 44, color: TINT[f.status] }}>{MARK[f.status]}</div>
            <div style={{ display: "flex" }}>{f.title}</div>
          </div>
        ))}
        {hiddenCount > 0 && <div style={{ display: "flex", marginTop: 10, marginLeft: 44, color: "#6b6f79" }}>{`+${hiddenCount} more`}</div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", paddingTop: 16 }}>
        <div style={{ display: "flex", fontSize: 22, color: "#6b6f79" }}>Automated analysis, not investment advice.</div>
        {/* The symbol above is shown large with no other hint that the token's creator chose it
            and can make it imitate another token — this line carries that, bounded to a width
            that leaves room to wrap without pushing the card past its fixed 630px height. */}
        {report && <div style={{ display: "flex", fontSize: 18, marginTop: 4, color: "#6b6f79", maxWidth: 1000 }}>{NAME_DISCLOSURE}</div>}
      </div>
    </div>
  );
}
