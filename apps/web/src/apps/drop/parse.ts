import { getAddress, isAddress } from "viem";
import { AmountError, parseTokenAmount, type Address } from "@arcos/chain";

export type DropRow = { line: number; address: Address; amount: bigint };
export type DropIssue = { line: number; message: string };

/**
 * Recipients per transaction. Measured in Foundry against Arc's 30,000,000 block gas limit:
 * 400 fresh native recipients cost roughly 14.1M gas inside the call, 400 fresh ERC-20
 * recipients roughly 10.9M, plus ~0.3-0.4M of calldata/intrinsic gas — matching
 * Multisend.MAX_RECIPIENTS (also 400). BATCH is kept well under that ceiling, at about a
 * quarter of the block, so a batch leaves headroom for the rest of the block's other
 * transactions. Testnet gas usage for a real batch is still worth confirming (see the R0 report).
 */
export const BATCH = 200;

/** Mirrors Multisend.MAX_RECIPIENTS — the hard cap the contract enforces per call. */
export const MAX_BATCH = 400;

/** Hard cap on non-empty rows a single parse will accept. Beyond this a paste is treated as unsafe to
 * even parse (let alone send), rather than silently truncated or slowly chewed through row by row. */
export const MAX_ROWS = 10_000;

const ZERO = "0x0000000000000000000000000000000000000000";

/** A header's first cell is text only: letters, spaces or underscores (`address`, `wallet_address`,
 * `Recipient`). Anything else — including a malformed address that merely lacks "0x" — is data, so a typo
 * on line 1 always surfaces as an issue instead of silently vanishing as a "header". */
const HEADER_CELL = /^[A-Za-z_ ]+$/;

/**
 * Splits a trimmed, non-empty line into its address token — everything up to the first run of whitespace,
 * comma or semicolon — and the amount text that follows that run, trimmed. The amount text is otherwise
 * untouched (its own internal commas survive) so `parseTokenAmount` sees exactly what the user typed and
 * can apply its own thousands-separator rules. `amountText` is `undefined` when nothing follows the
 * address (or only more separators do), meaning the line has no amount at all.
 */
function splitRow(trimmed: string): { address: string; amountText: string | undefined } {
  const sepIndex = trimmed.search(/[\s,;]/);
  if (sepIndex === -1) return { address: trimmed, amountText: undefined };
  const address = trimmed.slice(0, sepIndex);
  const rest = trimmed.slice(sepIndex).replace(/^[\s,;]+/, "").trim();
  return { address, amountText: rest === "" ? undefined : rest };
}

export function parseDropList(text: string, decimals: number): { rows: DropRow[]; issues: DropIssue[]; total: bigint } {
  const lines = text.split(/\r?\n/);
  const nonEmptyLines = lines.filter((l) => l.trim() !== "").length;
  if (nonEmptyLines > MAX_ROWS) {
    return { rows: [], issues: [{ line: 0, message: "A list can have at most 10,000 rows" }], total: 0n };
  }

  const rows: DropRow[] = [];
  const issues: DropIssue[] = [];
  const seen = new Map<string, number>();
  let total = 0n;

  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const { address: addr, amountText: amt } = splitRow(trimmed);
    if (line === 1 && HEADER_CELL.test(addr)) return; // header
    if (amt === undefined) return void issues.push({ line, message: "Expected an address and an amount" });
    if (!isAddress(addr, { strict: false })) return void issues.push({ line, message: "Not an address" });
    if (addr.toLowerCase() === ZERO) return void issues.push({ line, message: "The zero address can't receive funds on Arc" });
    const first = seen.get(addr.toLowerCase());
    if (first !== undefined) return void issues.push({ line, message: `Duplicate of line ${first}` });

    let amount: bigint;
    try {
      amount = parseTokenAmount(amt, decimals);
    } catch (e) {
      return void issues.push({ line, message: e instanceof AmountError ? e.message : "Bad amount" });
    }
    if (amount === 0n) return void issues.push({ line, message: "Amount is zero" });

    seen.set(addr.toLowerCase(), line);
    rows.push({ line, address: getAddress(addr), amount });
    total += amount;
  });

  return { rows, issues, total };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
