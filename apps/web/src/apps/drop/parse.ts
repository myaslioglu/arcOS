import { formatUnits, getAddress, isAddress } from "viem";
import { AmountError, formatUsdc, hasLoneComma, parseTokenAmount, unitsToNative, type Address } from "@arcos/chain";

export type DropRow = { line: number; address: Address; amount: bigint };
/** `ambiguous` is true for the two row-level reasons the list's own number-writing convention is in
 * doubt — the parser's own "ambiguous" code, or `COMMA_ROW_MESSAGE` below — and left unset for every
 * other kind of bad row (a bad address, a duplicate, zero, too much precision, ...). See
 * `hasAmbiguousIssue`. */
export type DropIssue = { line: number; message: string; ambiguous?: boolean };

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

/** I4/m5: a lone comma (one comma, no dot) right after a COMMA-separated address is refused
 * outright, rather than read as a decimal point — it could just as easily be a third CSV column,
 * and the row can't tell which. A semicolon, a tab or a space separator carries no such ambiguity,
 * so those rows keep `parseTokenAmount`'s own comma rules (decimal, thousands or ambiguous). Rm3:
 * worded for both kinds of writer — someone who meant a decimal comma, and someone who grouped
 * thousands with a comma (an unquoted US CSV's own style). */
const COMMA_ROW_MESSAGE =
  "In a comma-separated list, write amounts without a comma (1500, or 1.5), or separate the columns with a semicolon or a tab.";

/**
 * Splits a trimmed, non-empty line into its address token — everything up to the first run of whitespace,
 * comma or semicolon — and the amount text that follows that run, trimmed. The amount text is otherwise
 * untouched (its own internal commas survive) so `parseTokenAmount` sees exactly what the user typed and
 * can apply its own comma rules: thousands, a decimal point, or ambiguous. `amountText` is `undefined`
 * when nothing follows the address (or only more separators do), meaning the line has no amount at all.
 * `commaSeparated` is true when that run contains a comma ANYWHERE in it (RI1) — not just as its first
 * character, so a padded comma like " , " (the textarea's own placeholder style, `"0x… , 12.5"`) or
 * "\t," still counts — Drop's own signal (not the parser's) that a lone comma in the amount could just
 * as easily be a third column; see `COMMA_ROW_MESSAGE`.
 */
function splitRow(trimmed: string): { address: string; amountText: string | undefined; commaSeparated: boolean } {
  const sepIndex = trimmed.search(/[\s,;]/);
  if (sepIndex === -1) return { address: trimmed, amountText: undefined, commaSeparated: false };
  const address = trimmed.slice(0, sepIndex);
  const sepRun = /^[\s,;]+/.exec(trimmed.slice(sepIndex))?.[0] ?? "";
  const rest = trimmed.slice(sepIndex + sepRun.length).trim();
  return { address, amountText: rest === "" ? undefined : rest, commaSeparated: sepRun.includes(",") };
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
    const { address: addr, amountText: amt, commaSeparated } = splitRow(trimmed);
    if (line === 1 && HEADER_CELL.test(addr)) return; // header
    if (amt === undefined) return void issues.push({ line, message: "Expected an address and an amount" });
    if (!isAddress(addr, { strict: false })) return void issues.push({ line, message: "Not an address" });
    if (addr.toLowerCase() === ZERO) return void issues.push({ line, message: "The zero address can't receive funds on Arc" });
    const first = seen.get(addr.toLowerCase());
    if (first !== undefined) return void issues.push({ line, message: `Duplicate of line ${first}` });

    // I4/m5: checked before the parser ever sees the text — a lone comma right after a
    // comma-separated address is refused regardless of what the parser itself would call it
    // (a clean decimal, or ambiguous), because Drop's own reason for refusing it (a possible third
    // column) is different from the parser's.
    if (commaSeparated && hasLoneComma(amt)) {
      return void issues.push({ line, message: COMMA_ROW_MESSAGE, ambiguous: true });
    }

    let amount: bigint;
    try {
      amount = parseTokenAmount(amt, decimals);
    } catch (e) {
      if (e instanceof AmountError && e.code === "ambiguous") {
        return void issues.push({ line, message: e.message, ambiguous: true });
      }
      return void issues.push({ line, message: e instanceof AmountError ? e.message : "Bad amount" });
    }
    if (amount === 0n) return void issues.push({ line, message: "Amount is zero" });

    seen.set(addr.toLowerCase(), line);
    rows.push({ line, address: getAddress(addr), amount });
    total += amount;
  });

  return { rows, issues, total };
}

/** m5: true when any of `issues` is one the list's own number-writing convention might be read
 * wrong for (the parser's "ambiguous" code, or Drop's comma-column rule above) — as opposed to an
 * ordinarily bad row (a bad address, a duplicate, zero, too much precision, ...), which stays
 * "excluded, not fatal" (`canSend.ts`). Drop's Window blocks Send while this is true, and shows the
 * banner built by `ambiguousBannerText` below: a partial send under the wrong reading is worse than
 * asking for one row to be retyped. */
export function hasAmbiguousIssue(issues: readonly DropIssue[]): boolean {
  return issues.some((i) => i.ambiguous === true);
}

/** "lines 12, 57 and 3 more", "lines 3, 12 and 57", "lines 3 and 12", or "line 12" — up to 3
 * ambiguous rows named in full; past that, the first 2 plus a count of the rest, so the clause
 * never grows past 3 grammatical items regardless of how long the list is. */
function linesClause(lines: number[]): string {
  if (lines.length === 1) return `line ${lines[0]}`;
  if (lines.length <= 3) return `lines ${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
  return `lines ${lines.slice(0, 2).join(", ")} and ${lines.length - 2} more`;
}

/** m5/Rm2: the banner Drop's Window shows above the issues list whenever any row is ambiguous, or
 * `null` when none are (mirrors `hasAmbiguousIssue`). Names the ambiguous rows' own LINE NUMBERS
 * (not their position in `issues`), so it stays useful even when `IssuesList` itself only shows the
 * first 50 issues — an ambiguous row past that cutoff would otherwise be invisible. */
export function ambiguousBannerText(issues: readonly DropIssue[]): string | null {
  const lines = issues.filter((i) => i.ambiguous === true).map((i) => i.line);
  if (lines.length === 0) return null;
  return `Some amounts could be read two ways (${linesClause(lines)}). Fix those rows before sending.`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The size of each batch `count` items would split into at `size` per batch — the same numbers
 * `chunk(...).map(b => b.length)` would produce, computed arithmetically instead of by building a
 * `count`-length array just to measure it (useful when `count` is a quote, not a real row list).
 */
export function batchSizes(count: number, size: number): number[] {
  const sizes: number[] = [];
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(remaining, size);
    sizes.push(n);
    remaining -= n;
  }
  return sizes;
}

/**
 * The exact inverse of `parseDropList`: turns rows back into `address,amount` list text, one row per line,
 * with no thousands separators, so the result re-parses to the same amounts. `row.amount` is in the same
 * units `parseDropList` produced it in — 6-decimal USDC units for native mode (`token === null`), so it
 * needs `unitsToNative` before `formatUsdc` (which expects native wei); a real token's units already match
 * its own `decimals`, so `formatUnits` applies directly.
 */
export function formatDropList(rows: DropRow[], token: Address | null, decimals: number): string {
  return rows.map((r) => `${r.address},${token ? formatUnits(r.amount, decimals) : formatUsdc(unitsToNative(r.amount))}`).join("\n");
}
