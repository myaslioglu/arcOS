import { isAddress } from "viem";
import type { QuickAction } from "@arcos/shell";
import { shortAddress } from "./format";

export function quickActions(query: string): QuickAction[] {
  const q = query.trim();
  if (!isAddress(q, { strict: false })) return [];
  return [{ id: `inspect:${q}`, title: `Inspect ${shortAddress(q)}`, hint: "Token report", appId: "inspector", params: { token: q } }];
}
