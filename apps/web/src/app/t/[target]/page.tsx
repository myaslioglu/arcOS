import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { activeNetwork, arcInspectChain } from "@arcos/chain";
import { proofLoad } from "@/lib/inspect-route";
import { DegradedPage, ProofView, proofMetadata } from "@/lib/proof-view";

// Rendered on every request: an inspection is live chain data, and the explorer key is a runtime-only secret.
export const dynamic = "force-dynamic";

/** /t/<address>: the proof page on Arc. This form stays Arc's for good; another chain's is /t/<chain>/<address>. */
type Props = { params: Promise<{ target: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return proofMetadata(await proofLoad("arc", (await params).target));
}

export default async function ProofPage({ params }: Props) {
  const { target: address } = await params;
  const chain = arcInspectChain(activeNetwork());
  const report = await proofLoad("arc", address);
  if (report === "busy") return <DegradedPage chain={chain} address={address} message="ArcOS is busy reading other tokens. Reload in a few seconds." />;
  if (report === "error" || report === "limited") {
    return <DegradedPage chain={chain} address={address} message="Couldn't read the chain for this token right now. Try again in a minute." />;
  }
  // Thrown while the page renders, so Next answers 404 with its error document, whose <head> is
  // Next's own: no theme boot script and no stylesheet until the client has rendered the page, so a
  // dark-theme visitor can see a white frame first. Accepted for this rare dead end: an in-page "not
  // found" view or a loading.tsx would keep the layout's <head>, but both answer 200 instead of 404.
  if (!report) notFound();
  return <ProofView report={report} chain={chain} />;
}
