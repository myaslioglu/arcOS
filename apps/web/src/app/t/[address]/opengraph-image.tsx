import { ImageResponse } from "next/og";
import { isAddress } from "viem";
import type { Address } from "@arcos/chain";
import { NotAContract } from "@arcos/inspector";
import { InspectorBusy, cachedInspection } from "@/lib/inspect-server";
import { shortLabel, tokenLabel } from "@/lib/proof";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "ARC.os token report";

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
        // NotAContract (no token there) and InspectorBusy (backpressure) are expected outcomes,
        // not failures worth an operator's attention.
        if (!(e instanceof NotAContract) && !(e instanceof InspectorBusy)) {
          console.error("og inspect failed", address, e);
        }
        return null;
      })
    : null;
  const rows = report ? [...report.findings].sort((a, b) => Number(a.status === "pass") - Number(b.status === "pass")).slice(0, 4) : [];
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: 64, background: "#f6f7f9", color: "#14161c", fontSize: 32 }}>
        <div style={{ display: "flex", fontSize: 26, color: "#555a66" }}>ARC.os · token report on Arc</div>
        <div style={{ display: "flex", fontSize: 84, marginTop: 12 }}>{report ? shortLabel(tokenLabel(report), 16) : "Token not found"}</div>
        {report && <div style={{ display: "flex", fontSize: 40, marginTop: 4 }}>{`${report.passed} of ${report.total} checks pass`}</div>}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 36 }}>
          {rows.map((f) => (
            <div key={f.id} style={{ display: "flex", marginTop: 10 }}>
              <div style={{ display: "flex", width: 48, color: TINT[f.status] }}>{MARK[f.status]}</div>
              <div style={{ display: "flex" }}>{f.title}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", marginTop: "auto", fontSize: 22, color: "#6b6f79" }}>Automated analysis, not investment advice.</div>
      </div>
    ),
    size,
  );
}
