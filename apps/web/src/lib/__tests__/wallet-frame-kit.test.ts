import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViemAdapterFromProvider, resolveChainIdentifier } from "@circle-fin/adapter-viem-v2";
import { classifyBridgeFailure } from "@/apps/bridge/session";
import { classifySwapFailure } from "@/apps/swap/session";
import { EMBEDDED_FRAME_MESSAGE, isEmbeddedFrameRefusal } from "../wallet-frame";

// Circle's own adapter, the one lib/appkit.ts builds for Swap and Bridge, driven by a provider that answers what a
// send needs and refuses the send itself. The send is a plain value transfer: it takes the same execute path to the
// wallet as Swap's and Bridge's contract calls, and makes no network request (a contract call reads the chain first),
// so `fetch` is stubbed to fail loudly if one is ever made.
const TEXT =
  "Request blocked: embedded frames are not allowed for this origin. For your security, 4rcos.com can't make this request from an embedded frame.";
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const TO = "0x00000000000000000000000000000000000000f1";

type AdapterProvider = Parameters<typeof createViemAdapterFromProvider>[0]["provider"];
type PrepareParams = Parameters<Awaited<ReturnType<typeof createViemAdapterFromProvider>>["prepare"]>[0];

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("this test makes no network request")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The error the adapter throws when the wallet refuses the send. It fails the test if the send never reached the
 * wallet, so a control can't pass on an error thrown earlier (a validation failure, say). */
async function refusedSend(refuse: () => unknown): Promise<unknown> {
  const chain = resolveChainIdentifier("Arc_Testnet");
  const chainIdHex = `0x${(chain as unknown as { chainId: number }).chainId.toString(16)}`;
  let reachedWallet = false;
  const provider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_sendTransaction") {
        reachedWallet = true;
        throw refuse();
      }
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [ACCOUNT];
      if (method === "eth_chainId") return chainIdHex;
      throw new Error(`unexpected ${method}`);
    },
    on() {},
    removeListener() {},
  };
  const adapter = await createViemAdapterFromProvider({ provider: provider as unknown as AdapterProvider });
  let failure: unknown = undefined;
  try {
    const prepared = await adapter.prepare({ address: TO, value: 1n } as unknown as PrepareParams, { chain });
    await prepared.execute();
  } catch (err) {
    failure = err;
  }
  if (!reachedWallet) throw new Error("the send never reached the wallet");
  if (failure === undefined) throw new Error("the send was expected to fail");
  return failure;
}

describe("a refusal at the send, through Circle's own adapter", () => {
  // With no code, the kit reports an RPC endpoint error whose own code is 4001, which its isUserCancellationError
  // reads as a cancellation. The wallet's words sit under cause.trace.rawError.
  it.each([
    ["an Error with no code", () => new Error(TEXT)],
    ["a bare string", () => TEXT],
  ])("is recognized from %s, and Swap and Bridge say to reload rather than 'Cancelled.'", async (_shape, refuse) => {
    const err = await refusedSend(refuse);
    expect(isEmbeddedFrameRefusal(err)).toBe(true);
    expect(classifySwapFailure(err)).toBe(EMBEDDED_FRAME_MESSAGE);
    expect(classifyBridgeFailure(err, "Check the explorer.")).toBe(EMBEDDED_FRAME_MESSAGE);
  });

  it.each([4100, 4001])("is recognized under code %i", async (code) => {
    expect(isEmbeddedFrameRefusal(await refusedSend(() => ({ code, message: TEXT })))).toBe(true);
  });

  it("leaves another failure alone", async () => {
    expect(isEmbeddedFrameRefusal(await refusedSend(() => new Error("boom")))).toBe(false);
  });

  it("still reads a real cancellation as cancelled", async () => {
    const err = await refusedSend(() => ({ code: 4001, message: "User rejected the request." }));
    expect(isEmbeddedFrameRefusal(err)).toBe(false);
    expect(classifySwapFailure(err)).toBe("Cancelled.");
  });
});
