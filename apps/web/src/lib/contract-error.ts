import { formatUsdc } from "@arcos/chain";

/**
 * Shown for any error this module can't decode into one of the mappings below — a network hiccup,
 * an RPC provider's own error shape, a revert this app doesn't have a specific sentence for, or
 * anything else. Mirrors packages/inspector/src/inspect.ts's `guard()`: never show raw RPC text or
 * a URL to the user (it can leak internal endpoints or transport detail), and never let one
 * unrecognized shape crash the caller. The real error should still be logged by the caller if it's
 * worth investigating — this function only decides what the USER sees.
 */
export const GENERIC_TRANSACTION_ERROR = "The transaction didn't go through. Try again.";

/** Shown when the sender's balance can't cover the transaction's value (a fee, a Drop's total) plus gas, so
 * retrying as-is can't help. */
export const INSUFFICIENT_FUNDS_ERROR = "Your wallet doesn't have enough USDC to cover this and its gas. Add USDC on Arc, then try again.";

/**
 * A message this app already wrote for the user, as opposed to a wallet/RPC/contract error whose raw
 * text must never reach them directly — e.g. Drop's "the fee changed mid-send, stop before signing"
 * condition (apps/drop/useDrop.ts), which has nothing to decode: there's no revert, just a plain
 * stop condition with an already-safe, already-specific sentence. `describeContractError` returns
 * `.message` verbatim for this one error type, and only this one, so a message this app deliberately
 * authored isn't swallowed by the generic fallback the way any other unrecognized error would be.
 *
 * That guarantee only holds if every construction site follows one rule: the argument must always be
 * an app-authored LITERAL sentence, never built from `err.message`, `String(err)`, or any other text
 * this app doesn't control — doing so would let raw wallet/RPC/transport text reach the user through
 * the one path `describeContractError` treats as already safe. Enforced by a source-text scan in
 * __tests__/contract-error.test.ts, which fails if any `new UserFacingError(...)` call reads from
 * `.message` or `String(err`.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/** Mirrors Multisend.MAX_RECIPIENTS (packages/contracts/src/Multisend.sol) — the contract has no
 * separate "too many recipients" error; BadLists covers that along with a length mismatch or an
 * empty list, so the one sentence below has to cover all three. */
const MAX_RECIPIENTS = 400;

type DecodedRevert = { errorName: string; args: readonly unknown[] };

/** Throws — rather than silently returning `0n` — when `v` isn't actually a bigint: a decoded
 * revert's args are only as trustworthy as viem's ABI decoding of them, and a malformed/unexpected
 * shape must fall through to the generic message below (via the try/catch in describeContractError)
 * instead of rendering a confident-looking but wrong sentence like "It is now 0 USDC". */
const asBigInt = (v: unknown): bigint => {
  if (typeof v !== "bigint") throw new Error("expected a bigint revert argument");
  return v;
};

/** True when `err` — or anything in its `cause` chain — is a wallet-level user rejection: viem's
 * `UserRejectedRequestError` (matched by name, so this file doesn't need to import viem) or the raw
 * EIP-1193 code 4001 a wallet can send before viem wraps it. Mirrors the equivalent check already in
 * apps/drop/runDrop.ts and lib/network.ts — kept local here too so this module has no dependency on
 * any single app. */
function isUserRejection(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (e.name === "UserRejectedRequestError" || e.code === 4001) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Walks `err`'s cause chain looking for a decoded contract revert — viem's own
 * `ContractFunctionRevertedError` (matched by name), whose `.data.errorName`/`.data.args` are exactly
 * what `decodeErrorResult` produced (see node_modules/viem/errors/contract.ts). This manual walk
 * (rather than calling `err.walk(...)`, which only exists on a real viem `BaseError` instance) covers
 * the same shape `.walk()` would find — viem's own implementation is the same `.cause`-chain
 * traversal — while also working against a plain mocked error in tests.
 */
function findDecodedRevert(err: unknown): DecodedRevert | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { name?: unknown; data?: unknown; cause?: unknown };
    if (e.name === "ContractFunctionRevertedError") {
      const data = e.data as { errorName?: unknown; args?: unknown } | undefined;
      if (data && typeof data.errorName === "string") {
        return { errorName: data.errorName, args: Array.isArray(data.args) ? data.args : [] };
      }
      return null;
    }
    current = e.cause;
  }
  return null;
}

/**
 * True when `err`, or anything in its `cause` chain, says the sender's balance can't cover the transaction.
 * Arc's node answers an eth_call whose value exceeds the balance with {"code": -32003, "message":
 * "revert: OutOfFunds"} (measured on rpc.mainnet.arc.io, 2026-09-26). viem leaves that as a generic
 * TransactionRejectedRpcError rather than its own `InsufficientFundsError`, so both are matched here, plus a
 * geth-style "insufficient funds" message. The text is only matched, never shown.
 */
function isInsufficientFunds(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { name?: unknown; details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown };
    if (e.name === "InsufficientFundsError") return true;
    const text = [e.details, e.shortMessage, e.message].filter((t) => typeof t === "string").join(" ");
    if (/OutOfFunds|insufficient funds/i.test(text)) return true;
    current = e.cause;
  }
  return false;
}

type ErrorFormatter = (args: readonly unknown[]) => string;

/**
 * One entry per `type: "error"` item across the three generated ABIs
 * (packages/chain/src/abis/{feeController,tokenFactory,multisend}.ts) — every custom error FeeController,
 * TokenFactory or Multisend can revert with maps to a plain sentence here. `FeeTransferFailed` and
 * `ZeroFeeController` are declared identically in both TokenFactory and Multisend, so one entry serves
 * both (viem decodes the revert against whichever ABI made the call, but the name — and so the right
 * sentence — is the same either way). Covered by the ABI-completeness test in
 * __tests__/contract-error.test.ts, which fails if a future ABI error has no entry here.
 */
const CONTRACT_ERRORS: Record<string, ErrorFormatter> = {
  // --- FeeController — owner-only functions; a normal user should never trigger these, but every
  // declared error still needs a sentence in case one somehow surfaces (e.g. a stale UI calling an
  // owner-only write). ---
  AboveCap: (a) => `That fee is above its cap of ${formatUsdc(asBigInt(a[1]))} USDC.`,
  KeyExists: () => "That fee key has already been added.",
  NothingPending: () => "There is no pending fee change to apply.",
  OwnableInvalidOwner: () => "That address can't be the owner.",
  OwnableUnauthorizedAccount: () => "You don't have permission to do that.",
  RenounceDisabled: () => "Ownership can't be given up on this contract — only transferred.",
  TooEarly: () => "That change isn't in effect yet — a fee increase takes 48 hours to apply.",
  UnknownKey: () => "Unknown fee key.",
  ZeroRecipient: () => "The fee recipient can't be the zero address.",

  // --- TokenFactory ---
  BadDecimals: () => "Decimals must be a whole number from 0 to 18.",
  BadName: () => "Name must be 1-64 bytes, can't start or end with a space, and can't contain control, invisible or text-direction characters.",
  BadSymbol: () => "Symbol must be 1-16 characters of printable ASCII — letters, digits and punctuation, no spaces or accents.",
  CapBelowSupply: () => "The cap can't be below the initial supply.",
  CapWithoutMint: () => "Only a mintable token can have a cap.",
  ZeroHolder: () => "The holder address can't be zero.",
  ZeroSupply: () => "Initial supply must be more than zero.",
  WrongFee: (a) => `The fee changed while you were signing. It is now ${formatUsdc(asBigInt(a[0]))} USDC — check it and submit again.`,

  // --- Multisend ---
  // The ABI has no "TooManyRecipients" error (the brief's example name) — BadLists is what the
  // contract actually reverts with for an empty list, a length mismatch, AND more than
  // MAX_RECIPIENTS, so the one sentence below has to cover all three.
  BadLists: () => `The recipient list is invalid — addresses and amounts must match in length, and a batch can hold at most ${MAX_RECIPIENTS} recipients.`,
  WrongValue: (a) => `The amount sent doesn't match what's required. It should be ${formatUsdc(asBigInt(a[0]))} USDC — check it and submit again.`,
  NotAToken: () => "That address isn't a token contract.",
  RefundFailed: () => "Some transfers failed and the refund back to your wallet failed too. Nothing was sent — try again.",
  // Not "Row N": the contract's index is a position WITHIN the batch that was sent, not a line
  // number in the list the user typed — those diverge for batch 2 and beyond of a multi-batch send.
  ZeroAmount: () => "An amount in this batch is zero.",
  ReentrancyGuardReentrantCall: () => "That action is already in progress.",

  // --- Shared between TokenFactory and Multisend (declared identically in both ABIs) ---
  FeeTransferFailed: () => "The fee couldn't be forwarded to the fee recipient. Try again later.",
  ZeroFeeController: () => "The fee controller address can't be zero.",
};

/**
 * Turns a thrown wallet/contract error into one plain sentence a user can act on. Checks, in order:
 * 1. `UserFacingError` — a message this app already wrote, returned as-is.
 * 2. A wallet-level user rejection ("You cancelled the request in your wallet.").
 * 3. A decoded revert from FeeController, TokenFactory or Multisend, mapped to its sentence above.
 * 4. A balance too low for the value plus gas (`INSUFFICIENT_FUNDS_ERROR`).
 * 5. `GENERIC_TRANSACTION_ERROR` for anything else — deliberately never the raw error text: it can
 *    carry internal RPC detail or a URL (the same rule packages/inspector's checks follow for their
 *    own findings).
 */
export function describeContractError(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  if (isUserRejection(err)) return "You cancelled the request in your wallet.";

  const revert = findDecodedRevert(err);
  if (revert) {
    const format = CONTRACT_ERRORS[revert.errorName];
    if (format) {
      try {
        return format(revert.args);
      } catch {
        // A malformed/unexpected args shape falls through to the generic message below rather than
        // ever throwing out of an error-formatting function.
      }
    }
  }

  if (isInsufficientFunds(err)) return INSUFFICIENT_FUNDS_ERROR;

  return GENERIC_TRANSACTION_ERROR;
}
