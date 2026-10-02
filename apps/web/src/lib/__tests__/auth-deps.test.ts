import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { activeChain } from "@arcos/chain";

// A marker module that throws outside a server build; these tests only need what auth-deps.ts builds.
vi.mock("server-only", () => ({}));

import { authDeps } from "../auth-deps";
import { processGlobal } from "../process-global";
import { endpointHealth } from "../rpc-transport";
import { authRpcClient, serverRpcClient } from "../server-rpc";
import { buildSignInMessage, siteIdentity } from "../siwe";

// Review 1, Important 1: POST /api/auth/verify is open to anyone, and a smart-wallet signature makes the server run an
// eth_call the request chose (an ERC-6492 deploy call can burn all its gas). Those calls go through sign-in's own RPC
// client, whose failures cool only its own endpoint-health record, never the one the Inspector, /api/pulse, /badge and
// /t share, and which reads Arc's out-of-gas answer as the node's answer rather than as the endpoint failing.

const NOW = new Date("2026-09-30T12:00:00.000Z");

/** A signature by one key over a message naming another address: viem asks the RPC whether that address accepts it. */
async function smartWalletAttempt() {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const signer = privateKeyToAccount(generatePrivateKey());
  const message = buildSignInMessage({
    address: wallet.address,
    chainId: activeChain().id,
    nonce: "abcdefabcdefabcdefabcdefabcdefab",
    site: siteIdentity("https://4rcos.com")!,
    now: NOW,
  });
  return { message, signature: await signer.signMessage({ message }), now: NOW };
}

const inspectHealth = () => processGlobal("inspect.rpcHealth", endpointHealth);
const authHealth = () => processGlobal("auth.rpcHealth", endpointHealth);

describe("sign-in's RPC client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const health of [inspectHealth(), authHealth()]) {
      health.coolingUntil.clear();
      health.failedAt.clear();
    }
  });

  it("is one per process, and not the shared server client", () => {
    expect(authRpcClient()).toBe(authRpcClient());
    expect(authRpcClient()).not.toBe(serverRpcClient());
  });

  it("an out-of-gas verification asks one endpoint and cools nothing, least of all the shared inspect record", async () => {
    const tried: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      tried.push(String(input));
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32003, message: "out of gas: gas required exceeds: 30000000" } });
    });
    expect(inspectHealth().coolingUntil.size).toBe(0);

    const outcome = await authDeps()
      .verifySignature(await smartWalletAttempt())
      .then(
        (valid) => valid,
        () => "threw",
      );

    expect(outcome).not.toBe(true);
    expect(tried).toHaveLength(1);
    expect(inspectHealth().coolingUntil.size).toBe(0);
    expect(authHealth().coolingUntil.size).toBe(0);
  });

  it("an endpoint failing during a verification cools sign-in's own record, not the shared inspect one", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    await authDeps()
      .verifySignature(await smartWalletAttempt())
      .catch(() => undefined);
    expect(authHealth().coolingUntil.size).toBeGreaterThan(0);
    expect(inspectHealth().coolingUntil.size).toBe(0);
  });
});
