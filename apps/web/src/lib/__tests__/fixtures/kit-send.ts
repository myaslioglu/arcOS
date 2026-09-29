import { afterEach, beforeEach, vi } from "vitest";
import { createViemAdapterFromProvider, resolveChainIdentifier } from "@circle-fin/adapter-viem-v2";

// Circle's own adapter, the one lib/appkit.ts builds for Swap and Bridge, driven by a provider that answers what a
// send needs and refuses the send itself. The send is a plain value transfer: it takes the same execute path to the
// wallet as Swap's and Bridge's contract calls, and makes no network request (a contract call reads the chain first).
// A test that uses it calls `stubNoNetwork()`, so a request would fail it loudly.

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const TO = "0x00000000000000000000000000000000000000f1";

/** Makes every `fetch` in the calling test file fail, and restores it after each test. */
export function stubNoNetwork(): void {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("this test makes no network request")));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

type AdapterProvider = Parameters<typeof createViemAdapterFromProvider>[0]["provider"];
type PrepareParams = Parameters<Awaited<ReturnType<typeof createViemAdapterFromProvider>>["prepare"]>[0];

/** The error the adapter throws when the wallet answers the send with `refuse()`. It fails the test if the send never
 * reached the wallet, so a control can't pass on an error thrown earlier (a validation failure, say). */
export async function refusedSend(refuse: () => unknown): Promise<unknown> {
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
