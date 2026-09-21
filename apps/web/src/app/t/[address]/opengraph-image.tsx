import { ImageResponse } from "next/og";
import { isAddress } from "viem";
import type { Address } from "@arcos/chain";
import { NotAContract } from "@arcos/inspector";
import { InspectionTimeout, InspectorBusy, cachedInspection } from "@/lib/inspect-server";
import { NAME_DISCLOSURE, passLine, rankFindings, shortLabel, tokenLabel } from "@/lib/proof";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "ARC.os token report";
// Cached-by-default per next/og's route-segment-config behaviour; re-render at most every 5
// minutes so a badge doesn't go stale for the full life of a shared link.
export const revalidate = 300;

/**
 * next/og's default font is missing glyphs for U+2713 (✓) and U+2717 (✗) — they render as
 * tofu boxes. ✔ (U+2714) and a plain ASCII "X" are both present, so this set differs from the
 * page's own MARK (which renders as HTML and has full system-font fallback).
 */
const MARK = { pass: "✔", warn: "!", fail: "X", unknown: "?" } as const;
const TINT = { pass: "#0c8a4e", warn: "#b97309", fail: "#b42318", unknown: "#6b6f79" } as const;

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const report = isAddress(address, { strict: false })
    ? await cachedInspection(address as Address).catch((e) => {
        // NotAContract (no token there), InspectorBusy and InspectionTimeout (both backpressure)
        // are expected outcomes, not failures worth an operator's attention.
        if (!(e instanceof NotAContract) && !(e instanceof InspectorBusy) && !(e instanceof InspectionTimeout)) {
          console.error("og inspect failed", address, e);
        }
        return null;
      })
    : null;
  // Worst-first: a hidden fail or unknown must never be the thing the "+N more" cuts.
  const { shown: rows, hiddenCount } = report ? rankFindings(report.findings, 4) : { shown: [], hiddenCount: 0 };
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: 64, background: "#f6f7f9", color: "#14161c", fontSize: 32 }}>
        <div style={{ display: "flex", fontSize: 26, color: "#555a66" }}>ARC.os · token report on Arc</div>
        <div style={{ display: "flex", fontSize: 84, marginTop: 12 }}>{report ? shortLabel(tokenLabel(report), 16) : "Token not found"}</div>
        {report && <div style={{ display: "flex", fontSize: 40, marginTop: 4 }}>{passLine(report)}</div>}
        {report && !report.explorerReachable && (
          <div style={{ display: "flex", fontSize: 22, marginTop: 6, color: "#6b6f79" }}>The explorer didn&apos;t answer some checks.</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 36 }}>
          {rows.map((f) => (
            <div key={f.id} style={{ display: "flex", marginTop: 10 }}>
              <div style={{ display: "flex", width: 48, color: TINT[f.status] }}>{MARK[f.status]}</div>
              <div style={{ display: "flex" }}>{f.title}</div>
            </div>
          ))}
          {hiddenCount > 0 && <div style={{ display: "flex", marginTop: 10, marginLeft: 48, color: "#6b6f79" }}>{`+${hiddenCount} more`}</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
          <div style={{ display: "flex", fontSize: 22, color: "#6b6f79" }}>Automated analysis, not investment advice.</div>
          {/* The symbol above is shown large with no other hint that the token's creator chose it
              and can make it imitate another token — this line carries that, bounded to a width
              that leaves room to wrap without pushing the card past its fixed 630px height. */}
          {report && <div style={{ display: "flex", fontSize: 18, marginTop: 4, color: "#6b6f79", maxWidth: 1000 }}>{NAME_DISCLOSURE}</div>}
        </div>
      </div>
    ),
    size,
  );
}
