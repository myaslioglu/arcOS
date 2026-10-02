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
 * -32603 as well, including a gateway's "upstream unavailable", so it only counts with revert data. Its `raw` is safe
 * to read as that: viem only builds this error from a node's error (code 3, -32603, -32000 "execution reverted", or a
 * multicall's failed call), so `raw` is always the node's revert data, never bytes an answer left undecoded (a decode
 * error's `data`, which is why `data` only counts on a JSON-RPC error). And it's needed: when a payload names a known
 * error (Error, Panic) but its arguments won't decode, viem keeps the decode error as this error's cause, so the
 * node's code and data drop out of the chain and only `raw` still holds them.
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
      // viem decoded revert data (an Error, a Panic, a custom error), found an error selector it doesn't know, or kept
      // revert data it couldn't decode in `raw`.
      (named(l, "ContractFunctionRevertedError") && (typeof l.data === "object" || typeof l.signature === "string" || revertData(l.raw))),
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

/** Arc's code and text for an eth_call that ran out of gas mid-execution (not -32000 "intrinsic gas too low"). */
const OUT_OF_GAS_CODE = -32003;
const OUT_OF_GAS_TEXT = /^out of gas/i;

/**
 * The node said the call ran out of gas during execution: Arc's -32003 "out of gas: gas required exceeds: N", anywhere in
 * viem's cause chain, with no HTTP failure or timeout in it. Not a revert, and not read as one by `isRevert`: it only means
 * "the node answered" for a call that set its own gas limit (a v4 quote), where the same call gets the same answer anywhere.
 */
export function isOutOfGas(e: unknown): boolean {
  const links = chain(e);
  return !endpointFailed(links) && links.some((l) => l.code === OUT_OF_GAS_CODE && OUT_OF_GAS_TEXT.test(nodeText(l)));
}

/**
 * What a reverted call reverted with: the error selector and its arguments, from whichever link of viem's cause chain holds
 * them (the node's `data`, or a `ContractFunctionRevertedError`'s `raw`). `null` when there is none, or the node sent a bare
 * `0x`. Only meaningful for an error that `isRevert`.
 */
export function revertPayload(e: unknown): `0x${string}` | null {
  const hex = (v: unknown): `0x${string}` | null => (typeof v === "string" && /^0x([0-9a-f]{2})+$/i.test(v) ? (v as `0x${string}`) : null);
  for (const l of chain(e)) {
    const found =
      (named(l, "ContractFunctionRevertedError") ? hex(l.raw) : null) ??
      (typeof l.code === "number" ? hex(l.data) ?? (typeof l.data === "object" && l.data !== null ? hex((l.data as { data?: unknown }).data) : null) : null);
    if (found) return found;
  }
  return null;
}
