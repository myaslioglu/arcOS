import type { BridgeStep } from "@circle-fin/app-kit";

/** Step names that actually move funds off the source chain — the CCTP burn, or a plain send/
 * transfer on a non-CCTP path. An approval succeeding doesn't count: it only grants an allowance,
 * nothing has moved yet. Matched case-insensitively and by substring because `BridgeStep.name` is a
 * free-form string, not a typed enum — the SDK's own `CCTPV2Actions` keys
 * (node_modules/@circle-fin/app-kit/index.d.ts ~lines 14901-14934) are lowercase ('burn', 'mint',
 * 'approve'), while the interface's own doc comment illustrates them capitalized ("Burn"), so the
 * exact runtime casing isn't guaranteed either way. */
const SOURCE_LEG_KEYWORDS = ["burn", "send", "transfer"];

/**
 * True once a step that moves funds off the source chain has succeeded. Used to decide whether a
 * failed bridge (`BridgeResult.state === 'error'`) still needs the "your funds aren't lost"
 * reassurance, or whether nothing was ever signed.
 */
export function fundsLeftSource(steps: readonly BridgeStep[]): boolean {
  return steps.some((s) => s.state === "success" && SOURCE_LEG_KEYWORDS.some((k) => s.name.toLowerCase().includes(k)));
}

/**
 * Copy for path (a): `kit.bridge()` returned a result whose `state` is `'error'`, and a source-chain
 * step already succeeded. Null when nothing moved — there's nothing to reassure the user about, the
 * transfer never left the wallet.
 */
export function inFlightNote(sourceLabel: string, destLabel: string, fundsLeft: boolean): string | null {
  return fundsLeft ? `Your USDC left ${sourceLabel}. It isn't lost: it can still be delivered on ${destLabel}.` : null;
}

/**
 * Copy for path (b): `kit.bridge()` threw before returning any result at all, so there's no step
 * list to check — appended to the thrown error's own message.
 */
export function explorerCheckNote(sourceLabel: string): string {
  return `If your wallet confirmed a transaction on ${sourceLabel}, check it in that chain's explorer before trying again.`;
}
