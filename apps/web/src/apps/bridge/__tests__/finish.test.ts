import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toFunctionSelector } from "viem";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { Arc, ArcTestnet, Base, BaseSepolia } from "@circle-fin/app-kit/chains";
import { UserFacingError } from "@/lib/contract-error";
import {
  AttestationServiceError,
  FINISH_ALREADY_DONE,
  FINISH_SERVICE_DOWN,
  FINISH_UNKNOWN,
  FinishError,
  attestationUrl,
  describeFinishFailure,
  destinationSource,
  explorerTxUrl,
  lookupBurn,
  messageTransmitter,
  normalizeBurnHash,
  readAttestation,
  sameNetwork,
  sendMint,
  type AttestedBurn,
} from "../finish";
import { chainForDomain, kitChainDefinition } from "../chains";

const BURN = "0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b";
const NONCE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";

describe("normalizeBurnHash", () => {
  it("accepts a 32-byte hash, trimmed and lowercased", () => {
    expect(normalizeBurnHash(`  ${BURN.toUpperCase().replace("0X", "0x")} `)).toBe(BURN);
    expect(normalizeBurnHash(BURN)).toBe(BURN);
  });

  it("rejects anything else: short, long, no prefix, non-hex, an address, empty", () => {
    for (const bad of ["", "0x", BURN.slice(0, 65), `${BURN}0`, BURN.slice(2), `0x${"g".repeat(64)}`, "0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c", "7bd2"]) {
      expect(normalizeBurnHash(bad), bad).toBeNull();
    }
  });
});

describe("attestationUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  // The host and path the installed kit calls, and the domain from its own definition of the chain, never a guess.
  it("asks the mainnet service for a burn on Arc, by Arc's CCTP domain", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    expect(attestationUrl("Arc", BURN)).toBe(`https://iris-api.circle.com/v2/messages/${Arc.cctp.domain}?transactionHash=${BURN}`);
    expect(Arc.cctp.domain).toBe(26);
  });

  it("asks the sandbox service for a burn on a testnet chain", () => {
    expect(attestationUrl("Arc_Testnet", BURN)).toBe(`https://iris-api-sandbox.circle.com/v2/messages/${ArcTestnet.cctp.domain}?transactionHash=${BURN}`);
    expect(attestationUrl("Base_Sepolia", BURN)).toContain(`/v2/messages/${BaseSepolia.cctp.domain}?`);
  });
});

/** The shape of the service's answer for a complete CCTP v2 message (measured 2026-10-03), with made-up identifiers and the
 * two byte strings stood in for by repeated bytes of the real lengths. */
const complete = {
  messages: [
    {
      message: "0x" + "ab".repeat(376),
      eventNonce: NONCE,
      attestation: "0x" + "cd".repeat(130),
      cctpVersion: 2,
      status: "complete",
      decodedMessage: {
        sourceDomain: "26",
        destinationDomain: "6",
        nonce: NONCE,
        destinationCaller: "0x0000000000000000000000000000000000000000000000000000000000000000",
        decodedMessageBody: { burnToken: "0x3600000000000000000000000000000000000000", mintRecipient: "0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c", amount: "9000000", maxFee: "0" },
      },
      delayReason: null,
    },
  ],
};

describe("readAttestation", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet"));
  afterEach(() => vi.unstubAllEnvs());

  it("reads a complete attestation: the bytes for the mint, the destination by its domain, the amount and the recipient", () => {
    const lookup = readAttestation(complete);
    expect(lookup.kind).toBe("complete");
    if (lookup.kind !== "complete") return;
    expect(lookup.burn.dest).toBe("Base");
    expect(lookup.burn.amount).toBe("9");
    expect(lookup.burn.mintRecipient).toBe("0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c");
    expect(lookup.burn.eventNonce).toBe(NONCE);
    expect(lookup.burn.message).toHaveLength(754);
    expect(lookup.burn.attestation).toHaveLength(262);
  });

  it("names the testnet chain for the same domain on testnet", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    const lookup = readAttestation(complete);
    expect(lookup.kind === "complete" && lookup.burn.dest).toBe("Base_Sepolia");
    expect(chainForDomain(6)).toBe("Base_Sepolia");
    expect(chainForDomain(26)).toBe("Arc_Testnet");
  });

  it("is pending while Circle hasn't signed, or while the attestation bytes are missing", () => {
    const m = complete.messages[0]!;
    expect(readAttestation({ messages: [{ ...m, status: "pending_confirmations", attestation: "PENDING" }] })).toEqual({ kind: "pending" });
    expect(readAttestation({ messages: [{ ...m, attestation: undefined }] })).toEqual({ kind: "pending" });
  });

  it("is none for an empty or malformed answer", () => {
    for (const body of [{ messages: [] }, {}, null, "x", { messages: "no" }, { messages: [null] }]) {
      expect(readAttestation(body), JSON.stringify(body)).toEqual({ kind: "none" });
    }
  });

  it("refuses a destination this app doesn't bridge with", () => {
    const m = complete.messages[0]!;
    expect(readAttestation({ messages: [{ ...m, decodedMessage: { ...m.decodedMessage, destinationDomain: "5" } }] })).toEqual({ kind: "unknown-destination" });
    expect(readAttestation({ messages: [{ ...m, decodedMessage: undefined }] })).toEqual({ kind: "unknown-destination" });
  });

  it("shows ? for an amount it can't read, rather than a wrong number", () => {
    const m = complete.messages[0]!;
    const lookup = readAttestation({ messages: [{ ...m, decodedMessage: { ...m.decodedMessage, decodedMessageBody: { amount: "9e6" } } }] });
    expect(lookup.kind === "complete" && lookup.burn.amount).toBe("?");
    expect(lookup.kind === "complete" && lookup.burn.mintRecipient, "no recipient rather than a wrong one").toBeUndefined();
  });
});

describe("lookupBurn", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet"));
  afterEach(() => vi.unstubAllEnvs());

  const answer = (status: number, body?: unknown) =>
    (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(attestationUrl("Arc", BURN));
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as typeof fetch;

  it("returns the attestation the service gives", async () => {
    await expect(lookupBurn("Arc", BURN, answer(200, complete))).resolves.toMatchObject({ kind: "complete" });
  });

  it("reads the service's 404 as no such message", async () => {
    await expect(lookupBurn("Arc", BURN, answer(404, { error: "Message not found" }))).resolves.toEqual({ kind: "none" });
  });

  it("throws its own error, never the service's words, when the service fails or can't be reached", async () => {
    await expect(lookupBurn("Arc", BURN, answer(503, { error: "down" }))).rejects.toBeInstanceOf(AttestationServiceError);
    await expect(lookupBurn("Arc", BURN, answer(200, undefined))).rejects.toBeInstanceOf(AttestationServiceError);
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(lookupBurn("Arc", BURN, offline)).rejects.toBeInstanceOf(AttestationServiceError);
  });
});

describe("chain data from the kit", () => {
  it("takes the MessageTransmitterV2 address from App Kit's definition, the same on Base and Arc mainnet", () => {
    expect(messageTransmitter(kitChainDefinition("Base")!)).toBe(Base.cctp.contracts.v2.messageTransmitter);
    expect(messageTransmitter(kitChainDefinition("Arc")!)).toBe(Arc.cctp.contracts.v2.messageTransmitter);
    expect(Base.cctp.contracts.v2.messageTransmitter).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("links a mint to the destination's explorer, from the kit's template", () => {
    expect(explorerTxUrl("Base", BURN)).toBe(`https://basescan.org/tx/${BURN}`);
    expect(explorerTxUrl("Arc", BURN)).toBe(Arc.explorerUrl.replace("{hash}", BURN));
  });

  it("names the destination and its gas token for an error sentence", () => {
    expect(destinationSource("Base")).toEqual({ label: "Base", gasSymbol: "ETH" });
    expect(destinationSource("Polygon")).toEqual({ label: "Polygon", gasSymbol: "POL" });
  });

  it("knows which network a stored chain belongs to", () => {
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
    expect(sameNetwork("Base")).toBe(true);
    expect(sameNetwork("Base_Sepolia")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
    expect(sameNetwork("Base")).toBe(false);
    expect(sameNetwork("Arc_Testnet")).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("describeFinishFailure", () => {
  const base = { label: "Base", gasSymbol: "ETH" };

  it("shows a sentence this app wrote as it is", () => {
    expect(describeFinishFailure(new FinishError(FINISH_ALREADY_DONE("Base")), base)).toBe("This transfer was already delivered on Base. Nothing to finish.");
    expect(new FinishError("x")).toBeInstanceOf(UserFacingError);
  });

  it("has its own sentence for the attestation service failing", () => {
    expect(describeFinishFailure(new AttestationServiceError(503), base)).toBe(FINISH_SERVICE_DOWN);
  });

  it("words a refused mint, a refused switch and a gas shortfall like a failed mint step", () => {
    expect(describeFinishFailure({ code: 4001, message: "User rejected the request." }, base)).toBe("Rejected in your wallet.");
    expect(describeFinishFailure(new Error("Failed to switch to chain Base: boom"), base)).toBe("Your wallet didn't switch to Base.");
  });

  it("says the USDC isn't lost for anything else, and never the error's own words", () => {
    const sentence = describeFinishFailure(new Error("execution reverted: Nonce already used https://rpc.example"), base);
    expect(sentence).toBe(FINISH_UNKNOWN("Base"));
    expect(sentence).not.toMatch(/rpc.example|reverted/);
  });
});

/**
 * The mint through the kit's own adapter, against a stand-in wallet and a stand-in node: the node (every JSON-RPC request
 * the adapter's public client makes, over fetch) answers the simulation, the wallet signs. Nothing else may be fetched.
 *
 * In this node environment the adapter's `switchToChain` rebuilds its wallet client for the destination chain without a
 * `wallet_switchEthereumChain` request (adapter-viem-v2's `switchToChain` sends one only when `window` exists), so the
 * stand-in wallet is put on the destination chain by the test; viem's own check that the wallet's chain is the transaction's
 * runs either way, and the second test is that check refusing a wallet still on Arc.
 */
describe("sendMint", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const burn: AttestedBurn = {
    message: ("0x" + "ab".repeat(376)) as `0x${string}`,
    attestation: ("0x" + "cd".repeat(130)) as `0x${string}`,
    eventNonce: NONCE,
    dest: "Base",
    amount: "9",
    mintRecipient: "0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c",
  };
  const ACCOUNT = "0x00000000000000000000000000000000000000a1";
  const MINT_TX = `0x${"11".repeat(32)}`;

  /** Base's node: the chain id, a simulation that passes, a gas estimate. Records every URL it was asked. */
  function stubNode(): string[] {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      const body = JSON.parse(String(init?.body)) as { id: number; method: string } | { id: number; method: string }[];
      const one = (r: { id: number; method: string }) => {
        if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: `0x${Base.chainId.toString(16)}` };
        if (r.method === "eth_call") return { jsonrpc: "2.0", id: r.id, result: "0x" };
        if (r.method === "eth_estimateGas") return { jsonrpc: "2.0", id: r.id, result: "0x30000" };
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `not answered in this test: ${r.method}` } };
      };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
    });
    return fetched;
  }

  /** A wallet on `chainId` that signs with `sign`. Records every request. */
  async function stubWallet(chainId: number, sign: () => unknown) {
    const requests: { method: string; params?: unknown }[] = [];
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        requests.push({ method, params });
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ACCOUNT];
        if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_sendTransaction") return sign();
        throw new Error(`unexpected ${method}`);
      },
      on() {},
      removeListener() {},
    };
    const adapter = await createViemAdapterFromProvider({ provider: provider as unknown as Parameters<typeof createViemAdapterFromProvider>[0]["provider"] });
    return { adapter, requests };
  }

  it("sends receiveMessage(message, attestation) to the kit's MessageTransmitterV2 on the destination chain, from a wallet there", async () => {
    const fetched = stubNode();
    const { adapter, requests } = await stubWallet(Base.chainId, () => MINT_TX);

    await expect(sendMint(adapter, "Arc", burn)).resolves.toBe(MINT_TX);

    const sent = requests.filter((r) => r.method === "eth_sendTransaction");
    expect(sent).toHaveLength(1);
    const tx = (sent[0]!.params as [{ to: string; data: string }])[0];
    expect(tx.to.toLowerCase()).toBe(Base.cctp.contracts.v2.messageTransmitter.toLowerCase());
    // receiveMessage(bytes,bytes): the selector, then the two byte strings.
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector("function receiveMessage(bytes,bytes)"));
    expect(tx.data).toContain("ab".repeat(376));
    expect(tx.data).toContain("cd".repeat(130));
    // The node it simulated against is Base's, through the endpoints the kit names for Base (which the connect-src lists).
    expect(fetched.length).toBeGreaterThan(0);
    for (const url of fetched) expect(Base.rpcEndpoints.map((e) => new URL(e).origin), url).toContain(new URL(url).origin);
  });

  // The paid-write rule (lib/paid-write.ts): a transaction is pinned to its chain, so a wallet on another chain is refused
  // rather than signing there. The adapter hands viem the destination chain, and viem checks the wallet's.
  it("refuses to send from a wallet that is on another chain, instead of signing there", async () => {
    stubNode();
    const { adapter, requests } = await stubWallet(Arc.chainId, () => MINT_TX);
    await expect(sendMint(adapter, "Arc", burn)).rejects.toBeDefined();
    expect(requests.filter((r) => r.method === "eth_sendTransaction")).toEqual([]);
  });

  it("surfaces the wallet's refusal, which describeFinishFailure then words", async () => {
    stubNode();
    const { adapter } = await stubWallet(Base.chainId, () => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    });
    let failure: unknown;
    try {
      await sendMint(adapter, "Arc", burn);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeDefined();
    expect(describeFinishFailure(failure, destinationSource("Base"))).toBe("Rejected in your wallet.");
  });
});
