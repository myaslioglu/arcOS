import { getAddress, isAddress } from "viem";
import type { ArcosContracts } from "./addresses";

export type AddressSanityResult = { status: "not-deployed" } | { status: "ok" } | { status: "invalid"; issues: string[] };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Shape-level sanity check for `ARCOS[network]` — pure, no RPC call. `null` (the contracts aren't
 * deployed on this network yet — see addresses.ts's `ARCOS` comment) is a distinct, non-error
 * outcome, not a failure: a brand-new network with nothing deployed is expected, not broken.
 *
 * Once contracts ARE set, checks that `feeController`, `tokenFactory` and `multisend` are each a
 * well-formed, checksummed, non-zero address, and that all three are pairwise distinct (three
 * different contracts can never legitimately share one address). Reports every problem found, not
 * just the first.
 *
 * This is the OFF-CHAIN half of the address sanity check the brief asks for. The other half —
 * confirming `tokenFactory.feeController()` and `multisend.feeController()` both actually equal this
 * `feeController` on chain — needs a live read and is documented as a `cast call` sequence in
 * packages/contracts/DEPLOY.md under "After wiring the addresses", not run here.
 */
export function checkArcosAddresses(contracts: ArcosContracts | null): AddressSanityResult {
  if (contracts === null) return { status: "not-deployed" };

  const entries = Object.entries(contracts) as [keyof ArcosContracts, string][];
  const issues: string[] = [];

  for (const [name, address] of entries) {
    if (!isAddress(address, { strict: false })) {
      issues.push(`${name} isn't a valid address`);
      continue;
    }
    if (address.toLowerCase() === ZERO_ADDRESS) {
      issues.push(`${name} is the zero address`);
      continue;
    }
    if (address !== getAddress(address)) {
      issues.push(`${name} isn't checksummed — expected ${getAddress(address)}`);
    }
  }

  const lower = entries.map(([, address]) => address.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    issues.push("feeController, tokenFactory and multisend must be distinct addresses");
  }

  return issues.length > 0 ? { status: "invalid", issues } : { status: "ok" };
}
