import type { Metadata } from "next";
import { chainExplorerUrl, otherExplorerUrl, type InspectChain } from "@arcos/chain";
import type { Report } from "@arcos/inspector";
import { formatAppHash } from "@arcos/shell/core";
import type { ProofLoad } from "./inspect-route";
import { NAME_DISCLOSURE, chainLabel, passLine, readAtLine, summaryLine, tokenLabel } from "./proof";

/**
 * The proof page, /t/<address> on Arc and /t/<chain>/<address> elsewhere: its metadata and its body, from one load of the
 * report. Arc's page reads as it always has; another chain's names the chain, links its explorer (and another one beside
 * the address, which is never evidence), and opens the Inspector on that chain.
 */

const ROBOTS = { index: false, follow: false };

/** The link into the Inspector window for this token on `chain`: Arc's carries the token alone, as it always has. */
const appLink = (chain: InspectChain, address: string): string =>
  `/${formatAppHash("inspector", chain.key === "arc" ? { token: address } : { chain: chain.slug, token: address })}`;

/** The page's title and description: the summary line (which names the chain) for a report, else what kept it from one. */
export function proofMetadata(load: ProofLoad): Metadata {
  if (load === "busy") return { title: "ArcOS is busy — try again shortly", robots: ROBOTS };
  if (load === "limited") return { title: "Too many requests — ArcOS", robots: ROBOTS };
  if (load === "error") return { title: "Couldn't read the chain right now — ArcOS", robots: ROBOTS };
  if (!load) return { title: "Token not found — ArcOS", robots: ROBOTS };
  return { title: summaryLine(load), description: `An automated reading of this token's contract on ${chainLabel(load)}. Not investment advice.`, robots: ROBOTS };
}

const MARK = { pass: "✓", warn: "!", fail: "✗", unknown: "?" } as const;

/** Busy/timeout and a genuine failure to read the chain both degrade to this same shape — only
 * the message text differs. Never a 500: this is what "the report couldn't be produced" looks
 * like, and it still gives the visitor a way into the real app. */
export function DegradedPage({ chain, address, message }: { chain: InspectChain; address: string; message: string }) {
  return (
    <main className="mx-auto max-w-2xl p-6 text-sm">
      <p className="text-xs text-muted">ArcOS · proof page</p>
      <p className="mt-4">{message}</p>
      <a className="mt-6 inline-block rounded-md border border-border-2 px-3 py-1.5" href={appLink(chain, address)}>
        Open in ArcOS
      </a>
      <p className="mt-6 text-xs text-faint">Automated analysis, not investment advice.</p>
    </main>
  );
}

/** Why some checks are unknown on this page, when the explorer was left out or didn't answer; null when it answered. */
function explorerLine(report: Report, chain: InspectChain): string | null {
  if (report.explorerSkipped) return `${report.explorerSkipped} Some checks are unknown here.`;
  if (report.explorerReachable) return null;
  // On Arc the window reads the explorer from the browser, which it answers; off Arc the window reads this same server.
  return chain.key === "arc"
    ? "The explorer didn't answer this server, so some checks are unknown here. Open the token in ArcOS for the full reading."
    : "The explorer didn't answer this server, so some checks are unknown here.";
}

export function ProofView({ report, chain }: { report: Report; chain: InspectChain }) {
  const note = explorerLine(report, chain);
  const other = otherExplorerUrl(chain, "token", report.address);
  return (
    <main className="mx-auto max-w-2xl p-6 text-sm">
      <p className="text-xs text-muted">ArcOS · proof page</p>
      <h1 className="mt-1 text-xl font-medium break-words">{report.token.name ?? tokenLabel(report)}</h1>
      <p className="mt-1 text-xs text-muted">{NAME_DISCLOSURE}</p>
      <a className="break-all font-mono text-xs text-accent-text" href={chainExplorerUrl(chain, "token", report.address)}>{report.address}</a>
      {/* Off Arc: which chain this is, and the chain's best-known explorer beside the address (a link, never evidence). */}
      {chain.key !== "arc" && (
        <p className="mt-1 text-xs text-muted">
          {chain.name}
          {other && chain.otherExplorer && (
            <>
              {" · "}
              <a className="text-accent-text" href={other}>{`Open on ${chain.otherExplorer.name}`}</a>
            </>
          )}
        </p>
      )}
      <p className="mt-4 inline-block rounded-md bg-surface-2 px-2 py-1">{passLine(report)}</p>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
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
      <a className="mt-6 inline-block rounded-md border border-border-2 px-3 py-1.5" href={appLink(chain, report.address)}>
        Open in ArcOS
      </a>
      <p className="mt-6 text-xs text-faint">Automated analysis, not investment advice. {readAtLine(report)}.</p>
    </main>
  );
}
