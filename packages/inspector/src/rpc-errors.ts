/**
 * Whether a failed RPC call is the node answering, or the endpoint failing. One rule, used by the reader's
 * revert/transport split and by the web app's RPC transport:
 * - a revert is the node's answer: an error in the chain has code 3 (execution reverted), or the node's own message or
 *   data says "revert" (geth's "execution reverted", Arc's "revert: OutOfFunds"), or carries revert data. So is -32602
 *   invalid params;
 * - everything else is the endpoint failing: an HTTP error, a timeout, and every other JSON-RPC error (-32603, -32005,
 *   -32007, -32000 without "revert", -32601, -1, …), whatever HTTP status carried it. That says nothing about the
 *   contract, and is never evidence.
 *
 * viem's errors are recognised by name, not class, so the rule holds whichever copy of viem built them.
 */

const EXECUTION_REVERTED = 3;
const INVALID_PARAMS = -32602;
const REVERT_TEXT = /revert/i;
/** Revert data: at least a 4-byte error selector. */
const REVERT_DATA = /^0x[0-9a-f]{8}/i;

type Link = { name?: unknown; code?: unknown; details?: unknown; message?: unknown; shortMessage?: unknown; data?: unknown; raw?: unknown; signature?: unknown };

/** Every error in a cause chain, outermost first. */
function chain(e: unknown): Link[] {
  const links: Link[] = [];
  for (let c: unknown = e; typeof c === "object" && c !== null && links.length < 32; c = (c as { cause?: unknown }).cause) {
    links.push(c as Link);
  }
  return links;
}

const named = (link: Link, ...names: string[]): boolean => typeof link.name === "string" && names.includes(link.name);

/** What the node itself said. viem keeps it as `details` on every error it builds (its own `message` adds wording such
 * as "…reverted with the following reason…" even for a -32603, so it is never read); a raw provider error says it in
 * `message`. */
const nodeText = (link: Link): string => {
  const text = typeof link.shortMessage === "string" ? link.details : link.message;
  return typeof text === "string" ? text : "";
};

/** JSON-RPC error data that is revert data, or says it reverted (Nethermind's "Reverted 0x…"). */
const revertData = (data: unknown): boolean =>
  typeof data === "string"
    ? REVERT_DATA.test(data) || REVERT_TEXT.test(data)
    : typeof data === "object" && data !== null && "data" in data && revertData((data as { data: unknown }).data);

/** An HTTP failure or a timeout anywhere in the chain: the endpoint failed, whatever else the chain holds. */
const endpointFailed = (links: Link[]): boolean => links.some((l) => named(l, "HttpRequestError", "TimeoutError"));

/**
 * The node said the call reverted. viem's `ContractFunctionRevertedError` alone isn't enough: viem builds one for any
 * -32603 as well, including a gateway's "upstream unavailable", so it only counts with decoded revert data.
 */
export function isRevert(e: unknown): boolean {
  const links = chain(e);
  if (endpointFailed(links)) return false;
  return links.some(
    (l) =>
      l.code === EXECUTION_REVERTED ||
      REVERT_TEXT.test(nodeText(l)) ||
      // Only a JSON-RPC error's data is the node's: viem's decode errors keep the bytes they couldn't decode in `data`.
      (typeof l.code === "number" && revertData(l.data)) ||
      revertData(l.raw) ||
      (named(l, "ContractFunctionRevertedError") && (typeof l.data === "object" || typeof l.signature === "string")),
  );
}

/** The node answered the call: it reverted, or it rejected the params (-32602). */
export function isNodeAnswer(e: unknown): boolean {
  return isRevert(e) || (!endpointFailed(chain(e)) && chain(e).some((l) => l.code === INVALID_PARAMS));
}

/**
 * viem couldn't decode the node's answer (a `name()` that returns bytes32, say): the call itself went through — there
 * is no `CallExecutionError` underneath — so asking again returns the same bytes. Deterministic, never the endpoint's
 * fault.
 */
export function isDecodeFailure(e: unknown): boolean {
  const links = chain(e);
  return links.some((l) => named(l, "ContractFunctionExecutionError")) && !links.some((l) => named(l, "CallExecutionError")) && !endpointFailed(links);
}
