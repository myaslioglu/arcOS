import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAddress } from "viem";
import { explorerUrl, type Address } from "@arcos/chain";
import { NotAContract, type Report } from "@arcos/inspector";
import { formatAppHash } from "@arcos/shell/core";
import { InspectionTimeout, InspectorBusy, cachedInspection } from "@/lib/inspect-server";
import { NAME_DISCLOSURE, passLine, readAtLine, summaryLine, tokenLabel } from "@/lib/proof";

type Props = { params: Promise<{ address: string }> };

type LoadResult = Report | null | "busy" | "error";

async function load(address: string): Promise<LoadResult> {
  if (!isAddress(address, { strict: false })) return null;
  try {
    return await cachedInspection(address as Address);
  } catch (e) {
    if (e instanceof NotAContract) return null;
    if (e instanceof InspectorBusy || e instanceof InspectionTimeout) return "busy";
    console.error("proof page inspect failed", address, e);
    return "error";
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const robots = { index: false, follow: false };
  const report = await load((await params).address);
  if (report === "busy") return { title: "ARC.os is busy — try again shortly", robots };
  if (report === "error") return { title: "Couldn't read the chain right now — ARC.os", robots };
  if (!report) return { title: "Token not found — ARC.os", robots };
  return { title: summaryLine(report), description: "An automated reading of this token's contract on Arc. Not investment advice.", robots };
}

const MARK = { pass: "✓", warn: "!", fail: "✗", unknown: "?" } as const;

/** Busy/timeout and a genuine failure to read the chain both degrade to this same shape — only
 * the message text differs. Never a 500: this is what "the report couldn't be produced" looks
 * like, and it still gives the visitor a way into the real app. */
function DegradedPage({ address, message }: { address: string; message: string }) {
  return (
    <main className="mx-auto max-w-2xl p-6 text-sm">
      <p className="text-xs text-muted">ARC.os · proof page</p>
      <p className="mt-4">{message}</p>
      <a className="mt-6 inline-block rounded-md border border-border-2 px-3 py-1.5" href={`/${formatAppHash("inspector", { token: address })}`}>
        Open in ARC.os
      </a>
      <p className="mt-6 text-xs text-faint">Automated analysis, not investment advice.</p>
    </main>
  );
}

export default async function ProofPage({ params }: Props) {
  const { address } = await params;
  const report = await load(address);
  if (report === "busy") return <DegradedPage address={address} message="ARC.os is busy reading other tokens. Reload in a few seconds." />;
  if (report === "error") {
    return <DegradedPage address={address} message="Couldn't read the chain for this token right now. Try again in a minute." />;
  }
  if (!report) notFound();
  return (
    <main className="mx-auto max-w-2xl p-6 text-sm">
      <p className="text-xs text-muted">ARC.os · proof page</p>
      <h1 className="mt-1 text-xl font-medium break-words">{report.token.name ?? tokenLabel(report)}</h1>
      <p className="mt-1 text-xs text-muted">{NAME_DISCLOSURE}</p>
      <a className="break-all font-mono text-xs text-accent-text" href={explorerUrl("token", report.address)}>{report.address}</a>
      <p className="mt-4 inline-block rounded-md bg-surface-2 px-2 py-1">{passLine(report)}</p>
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
      <p className="mt-6 text-xs text-faint">Automated analysis, not investment advice. {readAtLine(report)}.</p>
    </main>
  );
}
