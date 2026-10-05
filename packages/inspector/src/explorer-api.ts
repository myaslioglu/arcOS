/** An explorer API to read instead of the chain's public one, with the key it needs. */
export type ExplorerApi = { url: string; apiKey: string };

/**
 * The Blockscout PRO key, trimmed, or undefined when there is none. The word `none` is no key too: App Hosting refuses an
 * empty value, so apphosting.testnet.yaml replaces the mainnet secret with it, and the testnet site reads the testnet
 * explorer's public API, which answers servers.
 */
function proKey(apiKey: string | undefined): string | undefined {
  const key = apiKey?.trim();
  return key && key !== "none" ? key : undefined;
}

/**
 * Blockscout's PRO API for `chainId`, or undefined without a key. Arc mainnet's public explorer answers browsers but
 * refuses server requests (a Cloudflare bot check), so the server reads the same Blockscout data from here instead.
 */
export function proExplorerApi(chainId: number, apiKey: string | undefined): ExplorerApi | undefined {
  const key = proKey(apiKey);
  return key ? { url: `https://api.blockscout.com/${chainId}/api/v2`, apiKey: key } : undefined;
}

/**
 * The same PRO API's Etherscan-style module endpoint (`?module=logs&action=getLogs…`), which Revoke reads approval
 * events from, with the same key; undefined without one. The key goes in the Authorization header, as for the
 * Inspector.
 */
export function proLogsApi(chainId: number, apiKey: string | undefined): ExplorerApi | undefined {
  const key = proKey(apiKey);
  return key ? { url: `https://api.blockscout.com/${chainId}/api`, apiKey: key } : undefined;
}
