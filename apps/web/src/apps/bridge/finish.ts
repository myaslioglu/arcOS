import { createPublicClient, fallback, formatUnits, http, parseAbi, type Hex } from "viem";
import type { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { USDC_DECIMALS, activeNetwork } from "@arcos/chain";
import { UserFacingError } from "@/lib/contract-error";
import { chainForDomain, chainLabel, kitChainDefinition, type ChainId, type KitChainDefinition } from "./chains";
import { STEP_UNKNOWN, describeStepError, type BridgeFailureSource } from "./session";

/**
 * Finishing a CCTP transfer from its burn transaction alone.
 *
 * A bridge is a burn on the source chain, an attestation of that burn by Circle, and a mint on the destination chain:
 * `MessageTransmitterV2.receiveMessage(message, attestation)`, which mints to the recipient encoded in the message. The
 * installed App Kit resumes a stopped bridge only from the `BridgeResult` object `kit.bridge()` returned
 * (`kit.retryBridge`); it has no entry point that takes a burn hash. A wallet that crashed on the mint, or a page that was
 * closed, loses that object, with the USDC burned and not yet minted. This module rebuilds the mint from what survives:
 * the burn hash, Circle's attestation service, and the kit's own adapter action for the mint.
 *
 * Nothing here is remembered from documentation. The attestation endpoint and hosts are the ones the installed kit
 * calls (node_modules/@circle-fin/app-kit/index.mjs, `IRIS_API_BASE_URL` and `/v2/messages/{sourceDomain}`); the source
 * domain, the MessageTransmitter address and the explorer come from the kit's chain definitions
 * (@circle-fin/app-kit/chains); the mint itself is the adapter's `cctp.v2.receiveMessage` action, the one
 * `kit.bridge()` runs, which resolves the contract address from the destination's definition and sends the transaction
 * on that chain (adapter-viem-v2: `ensureChain`, then viem's `sendTransaction` with the chain set, so the wallet signs
 * on that chain or not at all).
 *
 * Anyone may send `receiveMessage` for a message whose `destinationCaller` is zero, the kit's default for a bridge
 * (index.d.ts, `depositForBurn.destinationCaller`: "If not specified or set to bytes32(0), any address can call
 * receiveMessage"): the mint goes to the recipient in the message whatever wallet pays the gas, so a transfer can be
 * finished from another wallet or device than the one that burned.
 */

/** 32 bytes, 0x-prefixed: what an EVM transaction hash looks like. */
const TX_HASH = /^0x[0-9a-f]{64}$/;

/** The pasted hash, trimmed and lowercased, or null when it isn't a transaction hash. */
export function normalizeBurnHash(input: string): Hex | null {
  const hash = input.trim().toLowerCase();
  return TX_HASH.test(hash) ? (hash as Hex) : null;
}

/** The attestation service's hosts, as the installed kit names them (app-kit/index.mjs, lines ~14782-14783). */
const IRIS_MAINNET = "https://iris-api.circle.com";
const IRIS_TESTNET = "https://iris-api-sandbox.circle.com";

/** `GET /v2/messages/{sourceDomain}?transactionHash=` for a burn on `source`, on the host for its network. */
export function attestationUrl(source: ChainId, burnTxHash: Hex): string {
  const def = kitChainDefinition(source);
  if (!def) throw new Error(`attestationUrl: unknown chain ${source}`);
  const host = def.isTestnet ? IRIS_TESTNET : IRIS_MAINNET;
  return `${host}/v2/messages/${def.cctp.domain}?transactionHash=${burnTxHash}`;
}

/** What the mint needs from the attestation service, plus what the window shows about the transfer. */
export type AttestedBurn = {
  message: Hex;
  attestation: Hex;
  eventNonce: Hex;
  /** The chain the USDC is minted on, by the message's destination domain, on the active network. */
  dest: ChainId;
  /** USDC, as a decimal string ("9" for 9000000 units). */
  amount: string;
  /** The address the USDC is minted to: the one encoded in the burn, not whoever sends the mint. Undefined when the
   * service's answer didn't carry a readable one; the mint itself takes the recipient from the message bytes. */
  mintRecipient?: Hex;
};

export type BurnLookup =
  /** Circle has attested the burn: the mint can be sent. */
  | { kind: "complete"; burn: AttestedBurn }
  /** Circle has seen the burn but not attested it yet. */
  | { kind: "pending" }
  /** Circle knows no CCTP message for that hash on that chain. */
  | { kind: "none" }
  /** The message's destination is a chain this app doesn't bridge with, or is on the other network. */
  | { kind: "unknown-destination" };

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) && v.length > 2;

/**
 * Reads the service's answer: `{ messages: [{ status, message, attestation, eventNonce, decodedMessage: {
 * destinationDomain, decodedMessageBody: { amount, mintRecipient } } }] }`, the shape the kit validates
 * (app-kit/index.mjs, `messageSchema`) and the one measured on 2026-10-03 for a burn on Arc. Anything malformed reads as
 * "none" rather than throwing: this runs on a stranger's hash too.
 */
export function readAttestation(body: unknown): BurnLookup {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { kind: "none" };
  const m = messages[0] as Record<string, unknown>;
  if (typeof m !== "object" || m === null) return { kind: "none" };
  if (m.status !== "complete") return { kind: "pending" };
  if (!isHex(m.message) || !isHex(m.attestation) || !isHex(m.eventNonce)) return { kind: "pending" };
  const decoded = m.decodedMessage as { destinationDomain?: unknown; decodedMessageBody?: unknown } | undefined;
  const domain = Number(decoded?.destinationDomain);
  const dest = Number.isInteger(domain) ? chainForDomain(domain) : null;
  if (dest === null) return { kind: "unknown-destination" };
  const bodyOf = decoded?.decodedMessageBody as { amount?: unknown; mintRecipient?: unknown } | undefined;
  const units = typeof bodyOf?.amount === "string" && /^\d+$/.test(bodyOf.amount) ? BigInt(bodyOf.amount) : null;
  const mintRecipient = isHex(bodyOf?.mintRecipient) && bodyOf.mintRecipient.length === 42 ? bodyOf.mintRecipient : undefined;
  return {
    kind: "complete",
    burn: {
      message: m.message,
      attestation: m.attestation,
      eventNonce: m.eventNonce,
      dest,
      amount: units === null ? "?" : formatUnits(units, USDC_DECIMALS),
      ...(mintRecipient !== undefined && { mintRecipient }),
    },
  };
}

/** The service couldn't be reached or answered with an error: the lookup can be tried again. */
export class AttestationServiceError extends Error {
  constructor(status: number | null) {
    super(status === null ? "attestation service unreachable" : `attestation service answered ${status}`);
    this.name = "AttestationServiceError";
  }
}

/**
 * Asks Circle's attestation service about a burn. A 404 is the service's "no such message" (it answers one for a hash
 * it has never seen); any other failure throws `AttestationServiceError`.
 */
export async function lookupBurn(source: ChainId, burnTxHash: Hex, fetchFn: typeof fetch = fetch): Promise<BurnLookup> {
  let res: Response;
  try {
    res = await fetchFn(attestationUrl(source, burnTxHash), { headers: { accept: "application/json" } });
  } catch {
    throw new AttestationServiceError(null);
  }
  if (res.status === 404) return { kind: "none" };
  if (!res.ok) throw new AttestationServiceError(res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AttestationServiceError(res.status);
  }
  return readAttestation(body);
}

/** `usedNonces(bytes32)` of MessageTransmitterV2, as the kit's own ABI declares it (adapter-viem-v2/index.mjs,
 * `messageTransmitterV2Abi`): non-zero once the message was received, i.e. minted. */
const USED_NONCES_ABI = parseAbi(["function usedNonces(bytes32) view returns (uint256)"]);

/** The kit's MessageTransmitterV2 address on `chain`, from its chain definition (the same one the mint action resolves). */
export function messageTransmitter(def: KitChainDefinition): Hex {
  return def.cctp.contracts.v2.messageTransmitter as Hex;
}

/**
 * Whether the message was already received on the destination chain, read through App Kit's RPC endpoints for that
 * chain (the connect-src lists them). This is how an unfinished transfer is known to be finished after all: the mint may
 * have landed from a retry, another device, or Circle's relayer.
 */
export async function isDelivered(dest: ChainId, eventNonce: Hex): Promise<boolean> {
  const def = kitChainDefinition(dest);
  if (!def) throw new Error(`isDelivered: unknown chain ${dest}`);
  const client = createPublicClient({ transport: fallback(def.rpcEndpoints.map((url) => http(url))) });
  const used = await client.readContract({ address: messageTransmitter(def), abi: USED_NONCES_ABI, functionName: "usedNonces", args: [eventNonce] });
  return used !== 0n;
}

type Adapter = Awaited<ReturnType<typeof createViemAdapterFromProvider>>;

/**
 * Sends the mint with the connected wallet: the kit adapter's own `cctp.v2.receiveMessage` action, prepared and executed
 * the way `kit.bridge()` does it. The adapter switches the wallet to `dest` first and hands viem the chain, so the
 * transaction is signed on the destination chain or refused; it never goes out on whatever chain the wallet happens to
 * be on (the rule lib/paid-write.ts's `withChain` enforces for wagmi writes). Resolves to the mint's transaction hash.
 */
export async function sendMint(adapter: Adapter, source: ChainId, burn: AttestedBurn): Promise<Hex> {
  const fromChain = kitChainDefinition(source);
  const toChain = kitChainDefinition(burn.dest);
  if (!fromChain || !toChain) throw new Error("sendMint: unknown chain");
  const prepared = await adapter.prepareAction(
    "cctp.v2.receiveMessage",
    {
      message: burn.message,
      attestation: burn.attestation,
      eventNonce: burn.eventNonce,
      ...(burn.mintRecipient !== undefined && { mintRecipient: burn.mintRecipient }),
      fromChain,
      toChain,
    } as Parameters<Adapter["prepareAction"]>[1],
    { chain: toChain },
  );
  const hash = await prepared.execute();
  if (!isHex(hash)) throw new Error("sendMint: the adapter returned no transaction hash");
  return hash;
}

/** The explorer page of a transaction on `chain`, from the kit's `explorerUrl` template for it. */
export function explorerTxUrl(chain: ChainId, txHash: Hex): string | null {
  const def = kitChainDefinition(chain);
  return def ? def.explorerUrl.replace("{hash}", txHash) : null;
}

/** The destination chain as an error sentence names it. */
export function destinationSource(dest: ChainId): BridgeFailureSource {
  return { label: chainLabel(dest), gasSymbol: kitChainDefinition(dest)?.nativeCurrency.symbol ?? "gas token" };
}

/** A sentence this module wrote for a state the lookup found, shown as it is. */
export class FinishError extends UserFacingError {}

export const FINISH_NOT_FOUND = (sourceLabel: string) =>
  `No USDC transfer was found for this hash on ${sourceLabel}. Check the hash, and that it is the burn transaction, not the approval.`;
export const FINISH_PENDING = "Circle hasn't confirmed this transfer yet. Wait a minute and try again.";
export const FINISH_UNKNOWN_DESTINATION = "This transfer goes to a chain Bridge doesn't offer on this network.";
export const FINISH_SERVICE_DOWN = "The bridge service didn't answer. Try again in a minute.";
export const FINISH_ALREADY_DONE = (destLabel: string) => `This transfer was already delivered on ${destLabel}. Nothing to finish.`;
export const FINISH_UNKNOWN = (destLabel: string) => `The mint on ${destLabel} didn't go through. Your USDC isn't lost: try again.`;

/**
 * What a failed finish says, in the app's words and never the wallet's, the node's or the SDK's: a sentence this module
 * wrote (`FinishError`) as it is; a service failure its own sentence; a mint the wallet refused, a chain it didn't switch
 * to, or a gas shortfall on the destination chain, the sentence `describeStepError` gives a failed mint step for the same
 * error; anything else one generic sentence that says the USDC isn't lost.
 */
export function describeFinishFailure(err: unknown, dest: BridgeFailureSource): string {
  if (err instanceof UserFacingError) return err.message;
  if (err instanceof AttestationServiceError) return FINISH_SERVICE_DOWN;
  const sentence = describeStepError({ error: err }, dest);
  return sentence === STEP_UNKNOWN ? FINISH_UNKNOWN(dest.label) : sentence;
}

/** The network the stored transfers belong to: an entry from the other network is never offered for finishing. */
export function sameNetwork(chain: ChainId): boolean {
  const def = kitChainDefinition(chain);
  return def !== null && def.isTestnet === (activeNetwork() !== "mainnet");
}
