import { formatUsdc } from "@arcos/chain";

/** The FeeController values the About window states, as read from chain (native 18-decimal wei). */
export type FeeReadings = {
  mint: bigint;
  mintCap: bigint;
  perRecipient: bigint;
  perRecipientCap: bigint;
  dropMin: bigint;
  dropMinCap: bigint;
};

type ReadResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

/**
 * The six reads, in order: fee and cap of MINT_FLAT, of DROP_PER_RECIPIENT, then of DROP_MIN. "loading" until they come
 * back, and "error" if any failed, so the window never states a fee it didn't read.
 */
export function readingsFrom(results: readonly ReadResult[] | undefined): FeeReadings | "loading" | "error" {
  if (!results) return "loading";
  const values = results.map((r) => (r.status === "success" && typeof r.result === "bigint" ? r.result : null));
  if (values.length !== 6 || values.some((v) => v === null)) return "error";
  const [mint, mintCap, perRecipient, perRecipientCap, dropMin, dropMinCap] = values as bigint[];
  return { mint: mint!, mintCap: mintCap!, perRecipient: perRecipient!, perRecipientCap: perRecipientCap!, dropMin: dropMin!, dropMinCap: dropMinCap! };
}

export function feeSentence(fees: FeeReadings | "loading" | "error"): string {
  if (fees === "loading") return "Current fees: reading them from the FeeController…";
  if (fees === "error") return "Current fees couldn't be read right now. Mint and Drop show the exact fee before you sign.";
  return (
    `Current fees: Mint ${formatUsdc(fees.mint)} USDC flat (capped at ${formatUsdc(fees.mintCap)} USDC). ` +
    `Drop ${formatUsdc(fees.perRecipient)} USDC per recipient, ${formatUsdc(fees.dropMin)} USDC minimum ` +
    `(capped at ${formatUsdc(fees.perRecipientCap)} USDC per recipient, ${formatUsdc(fees.dropMinCap)} USDC minimum).`
  );
}
