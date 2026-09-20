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

const ZERO = "0x0000000000000000000000000000000000000000";

export function parseDropList(text: string, decimals: number): { rows: DropRow[]; issues: DropIssue[]; total: bigint } {
  const rows: DropRow[] = [];
  const issues: DropIssue[] = [];
  const seen = new Map<string, number>();
  let total = 0n;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const cells = raw.trim().split(/[\s,;]+/).filter(Boolean);
    if (cells.length === 0) return;
    const [addr = "", amt] = cells;
    if (line === 1 && !addr.startsWith("0x")) return; // header
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
