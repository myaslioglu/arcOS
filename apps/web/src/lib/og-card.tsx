import type { Report } from "@arcos/inspector";
import { shortAddress } from "./format";
import { findingRowBudget } from "./og-layout";
import { NAME_DISCLOSURE, passLine, rankFindings, shortLabel, tokenLabel } from "./proof";

/**
 * Each status's finding row used to lead with a glyph (✔/!/X/?) coloured by TINT below. next/og's
 * default font has no glyph for U+2713 (✓) or U+2717 (✗) at all (they render as tofu boxes), so the
 * previous fix picked ✔ (U+2714) and a plain ASCII "X" instead — but ✔ still isn't in the default
 * font, so satori falls back to an emoji font for it, and an emoji glyph ignores the `color` CSS
 * property entirely: ✔ rendered dark/untinted while "!"/"X"/"?" (ordinary text glyphs) took their
 * tint normally, so the four statuses read as visually inconsistent. Small solid-colour marks —
 * plain `background`/`border`/`borderRadius` divs, not text at all — sidestep font fallback
 * entirely, so every status tints the same way.
 */
const TINT = { pass: "#0c8a4e", warn: "#b97309", fail: "#b42318", unknown: "#6b6f79" } as const;

/**
 * Green, amber and red are the classic colour-blind confusion set, and this card is often the only
 * part of a report anyone sees — it's what a link preview shows in a chat. So the marks differ by
 * SHAPE as well as hue: a filled circle passed, a filled square failed, a diamond warns, and a
 * hollow ring means the check couldn't be resolved (nothing inside it, because nothing is known).
 * All four are drawn divs, for the font-fallback reason above.
 */
const MARK = {
  pass: { width: 22, height: 22, borderRadius: 11, background: TINT.pass },
  warn: { width: 17, height: 17, background: TINT.warn, transform: "rotate(45deg)" },
  fail: { width: 20, height: 20, borderRadius: 3, background: TINT.fail },
  unknown: { width: 22, height: 22, borderRadius: 11, border: `4px solid ${TINT.unknown}` },
} as const;

/**
 * The whole card as a function of the report, so its worst case — explorer unreachable, a long
 * symbol, every row a different status — can be rendered and LOOKED at without a server.
 *
 * The card is a fixed 1200x630 box, and overflowing it doesn't just cut the bottom off: satori
 * shrinks the overflowing children, so the symbol, the pass line and the explorer note collapse
 * into each other and overlap. The thing that goes first is the footer — the disclosure that this
 * name was chosen by whoever deployed the contract.
 *
 * How many finding rows fit is computed from everything else on the card — see `og-layout.ts`,
 * which owns that budget and is unit-tested, so a line added here can't silently spend the room
 * the footer needs. `rankFindings` fills the rows worst-first, so what "+N more" hides is never
 * the worst news.
 */
export function ogCard(report: Report | null) {
  const explorerNote = report !== null && !report.explorerReachable;
  const { shown: rows, hiddenCount } = report
    ? rankFindings(report.findings, findingRowBudget(explorerNote))
    : { shown: [], hiddenCount: 0 };
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: 48, background: "#f6f7f9", color: "#14161c", fontSize: 30 }}>
      <div style={{ display: "flex", fontSize: 26, color: "#555a66" }}>
        {/* The disclosure at the bottom says "check the address" without showing one anywhere on
            the card — this is that address, short-formed, fixed-width regardless of the token's
            own (attacker-controlled) name/symbol length above, so it never risks the header line
            wrapping. */}
        {report ? `4rc.OS · token report on Arc · ${shortAddress(report.address)}` : "4rc.OS · token report on Arc"}
      </div>
      <div style={{ display: "flex", fontSize: 64, marginTop: 12 }}>{report ? shortLabel(tokenLabel(report), 16) : "Token not found"}</div>
      {report && <div style={{ display: "flex", fontSize: 40, marginTop: 4 }}>{passLine(report)}</div>}
      {explorerNote && (
        <div style={{ display: "flex", fontSize: 22, marginTop: 6, color: "#6b6f79" }}>The explorer didn&apos;t answer some checks.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 24 }}>
        {rows.map((f) => (
          <div key={f.id} style={{ display: "flex", alignItems: "center", marginTop: 10 }}>
            <div style={{ display: "flex", width: 44, height: 26, alignItems: "center", justifyContent: "center" }}>
              <div style={{ display: "flex", ...MARK[f.status] }} />
            </div>
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
