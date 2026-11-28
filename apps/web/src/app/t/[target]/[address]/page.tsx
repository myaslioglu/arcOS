import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { proofLoad, routeChain, takePageTurn } from "@/lib/inspect-route";
import { DegradedPage, ProofView, proofMetadata } from "@/lib/proof-view";

// Rendered on every request: an inspection is live chain data, and the keys are runtime-only secrets.
export const dynamic = "force-dynamic";

/**
 * /t/<chain>/<address>: the proof page on a chain other than Arc, where this site reads it, and 404 where it doesn't.
 * /t/arc/<address> is redirected to /t/<address> (next.config.ts) before it gets here; this page redirects it too.
 */
type Props = { params: Promise<{ target: string; address: string }> };

/**
 * One load per request, shared by the metadata and the body (React's `cache` is per request), so a visit takes one turn
 * from the limiter, not two.
 */
const load = cache(async (target: string, address: string) => {
  const chain = routeChain(target);
  if (!chain) return { chain: null, report: null } as const;
  const report = await proofLoad(chain.key, address, async () => !takePageTurn(await headers()).ok);
  return { chain, report } as const;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { target, address } = await params;
  if (target === "arc") permanentRedirect(`/t/${address}`);
  const { chain, report } = await load(target, address);
  if (!chain) return { title: "Page not found — ArcOS", robots: { index: false, follow: false } };
  return proofMetadata(report);
}

export default async function ChainProofPage({ params }: Props) {
  const { target, address } = await params;
  if (target === "arc") permanentRedirect(`/t/${address}`);
  const { chain, report } = await load(target, address);
  if (!chain) notFound();
  if (report === "busy") return <DegradedPage chain={chain} address={address} message="ArcOS is busy reading other tokens. Reload in a few seconds." />;
  if (report === "limited") return <DegradedPage chain={chain} address={address} message="Too many requests from here. Try again in a minute." />;
  if (report === "error") return <DegradedPage chain={chain} address={address} message="Couldn't read the chain for this token right now. Try again in a minute." />;
  if (!report) notFound();
  return <ProofView report={report} chain={chain} />;
}
