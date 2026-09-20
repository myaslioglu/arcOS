"use client";

import { Check, CircleHelp, TriangleAlert, X } from "lucide-react";
import type { Finding } from "@arcos/inspector";

const ICON = {
  pass: <Check size={16} className="text-accent-2-text" aria-label="Pass" />,
  warn: <TriangleAlert size={16} className="text-accent-3-text" aria-label="Warning" />,
  fail: <X size={16} className="text-red-600" aria-label="Fail" />,
  unknown: <CircleHelp size={16} className="text-faint" aria-label="Unknown" />,
} as const;

const FIX_LABEL = { vault: "Lock in Vault", vesting: "Vest in Vesting" } as const;

export function FindingRow({ finding, onFix }: { finding: Finding; onFix: (app: "vault" | "vesting") => void }) {
  return (
    <li className="flex items-start gap-3 border-b border-border py-2.5 last:border-0">
      <span className="mt-0.5">{ICON[finding.status]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm">{finding.title}</p>
        <p className="text-xs text-muted">{finding.detail}</p>
      </div>
      {finding.fixAppId && finding.status !== "pass" && (
        <button type="button" className="rounded-md border border-border-2 px-2 py-1 text-xs" onClick={() => onFix(finding.fixAppId!)}>
          {FIX_LABEL[finding.fixAppId]}
        </button>
      )}
      {finding.evidenceUrl && (
        <a className="text-xs text-accent-text" href={finding.evidenceUrl} target="_blank" rel="noreferrer">
          Evidence
        </a>
      )}
    </li>
  );
}
