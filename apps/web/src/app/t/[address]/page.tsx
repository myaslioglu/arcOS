import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAddress } from "viem";
import { explorerUrl, type Address } from "@arcos/chain";
import { NotAContract, type Report } from "@arcos/inspector";
import { formatAppHash } from "@arcos/shell/core";
import { InspectorBusy, cachedInspection } from "@/lib/inspect-server";
import { summaryLine, tokenLabel } from "@/lib/proof";

type Props = { params: Promise<{ address: string }> };

async function load(address: string): Promise<Report | null | "busy"> {
  if (!isAddress(address, { strict: false })) return null;
  try {
    return await cachedInspection(address as Address);
  } catch (e) {
    if (e instanceof NotAContract) return null;
    if (e instanceof InspectorBusy) return "busy";
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const report = await load((await params).address);
  if (report === "busy") return { title: "ARC.os is busy — try again shortly" };
  if (!report) return { title: "Token not found — ARC.os" };
  return { title: summaryLine(report), description: "An automated reading of this token's contract on Arc. Not investment advice." };
}

const MARK = { pass: "✓", warn: "!", fail: "✗", unknown: "?" } as const;

export default async function ProofPage({ params }: Props) {
  const report = await load((await params).address);
  if (report === "busy") {
    return (
      <main className="mx-auto max-w-2xl p-6 text-sm">
        <p className="text-xs text-muted">ARC.os · proof page</p>
        <p className="mt-4">ARC.os is busy reading other tokens. Reload in a few seconds.</p>
        <p className="mt-6 text-xs text-faint">Automated analysis, not investment advice.</p>
      </main>
    );
  }
  if (!report) notFound();
  const readAt = report.blockNumber === "unknown" ? "Read at an unknown block" : `Read at block ${report.blockNumber}`;
  return (
    <main className="mx-auto max-w-2xl p-6 text-sm">
      <p className="text-xs text-muted">ARC.os · proof page</p>
      <h1 className="mt-1 text-xl font-medium">{report.token.name ?? tokenLabel(report)}</h1>
      <a className="font-mono text-xs text-accent-text" href={explorerUrl("token", report.address)}>{report.address}</a>
      <p className="mt-4 inline-block rounded-md bg-surface-2 px-2 py-1">{report.passed} of {report.total} checks pass</p>
      {!report.explorerReachable && (
        <p className="mt-2 text-xs text-muted">{"The explorer didn't answer this server, so some checks are unknown here. Open the token in ARC.os for the full reading."}</p>
      )}
      <ul className="mt-4">
        {report.findings.map((f) => (
          <li key={f.id} className="flex gap-3 border-b border-border py-2.5">
            <span aria-hidden className="w-4 text-center font-mono">{MARK[f.status]}</span>
            <div className="flex-1">
              <p>{f.title}</p>
              <p className="text-xs text-muted">{f.detail}</p>
            </div>
            {f.evidenceUrl && <a className="text-xs text-accent-text" href={f.evidenceUrl}>Evidence</a>}
          </li>
        ))}
      </ul>
      <a className="mt-6 inline-block rounded-md border border-border-2 px-3 py-1.5" href={`/${formatAppHash("inspector", { token: report.address })}`}>
        Open in ARC.os
      </a>
      <p className="mt-6 text-xs text-faint">
        Automated analysis, not investment advice. {readAt} · {report.generatedAt.slice(0, 16).replace("T", " ")} UTC.
      </p>
    </main>
  );
}
