import { isAddress } from "viem";
import type { QuickAction } from "@arcos/shell";
import { shortAddress } from "./format";
import { chainName, inspectorParams, pickToken, readsOtherChains, siteInspectChains } from "./inspect-chain-pick";

/**
 * The launcher's (Ctrl K) actions for what was typed. While the site reads Arc alone, a pasted address gives the one
 * action it always has. Once it reads other chains, a link or `<chain>:0x…` that names a chain gives one action, on that
 * chain ("Inspect 0x… on Base"), and a bare address gives one for each chain, Arc's first.
 */
export function quickActions(query: string): QuickAction[] {
  const q = query.trim();
  if (!readsOtherChains()) {
    if (!isAddress(q, { strict: false })) return [];
    return [{ id: `inspect:${q}`, title: `Inspect ${shortAddress(q)}`, hint: "Token report", appId: "inspector", params: { token: q } }];
  }
  const picked = pickToken(q);
  if (picked.kind !== "token") return [];
  // A bare address keeps what was typed, as it always has; a link gives the address it names.
  const address = picked.chain ? picked.address : q;
  return (picked.chain ? [picked.chain] : siteInspectChains()).map((chain) => ({
    id: `inspect:${chain.slug}:${address}`,
    title: `Inspect ${shortAddress(address)} on ${chainName(chain)}`,
    hint: "Token report",
    appId: "inspector",
    params: inspectorParams(chain, address),
  }));
}
