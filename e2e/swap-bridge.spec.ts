import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, multicall3Abi, toFunctionSelector, type Hex } from "viem";

// Swap and Bridge with a connected wallet, in a real browser against the production build. Nothing here reaches a real
// wallet or chain: the page gets a stand-in EIP-1193 wallet (window.ethereum), and every JSON-RPC request to Arc's node
// is answered here, so the balances are fixed and the run doesn't depend on the network.

const ACCOUNT = "0x000000000000000000000000000000000000dEaD";
/** 4.835553 USDC, as Arc's native balance (18 decimals) reports it. */
const NATIVE_BALANCE = 4_835_553n * 10n ** 12n;
const ARC_CHAIN_ID = 5042;

type RpcRequest = { id: number; method: string; params?: unknown[] };
type Call = { target: Hex; allowFailure: boolean; callData: Hex };

const hex = (n: bigint | number): Hex => `0x${n.toString(16)}`;

/**
 * One contract read, by its selector: Multicall3's `getEthBalance` (how viem reads a native balance when wagmi batches
 * reads through Multicall3, which is the default) and an ERC-20 `balanceOf` (EURC, cirBTC: nothing held). Anything else
 * fails, and the caller sees a failed read.
 */
function read(callData: Hex): Hex | null {
  const selector = callData.slice(0, 10);
  if (selector === toFunctionSelector("function getEthBalance(address)")) return encodeAbiParameters([{ type: "uint256" }], [NATIVE_BALANCE]);
  if (selector === toFunctionSelector("function balanceOf(address)")) return encodeAbiParameters([{ type: "uint256" }], [0n]);
  return null;
}

function answer({ id, method, params }: RpcRequest) {
  switch (method) {
    case "eth_chainId":
      return { jsonrpc: "2.0", id, result: hex(ARC_CHAIN_ID) };
    case "eth_getBalance":
      return { jsonrpc: "2.0", id, result: hex(NATIVE_BALANCE) };
    case "eth_blockNumber":
      return { jsonrpc: "2.0", id, result: hex(1_000_000) };
    case "eth_call": {
      const { data } = (params?.[0] ?? {}) as { data?: Hex };
      if (!data) break;
      if (data.slice(0, 10) === toFunctionSelector("function aggregate3((address,bool,bytes)[])")) {
        const { args } = decodeFunctionData({ abi: multicall3Abi, data });
        const calls = args[0] as readonly Call[];
        const results = calls.map((c) => {
          const out = read(c.callData);
          return { success: out !== null, returnData: out ?? "0x" };
        });
        return { jsonrpc: "2.0", id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }) };
      }
      const out = read(data);
      if (out) return { jsonrpc: "2.0", id, result: out };
      break;
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `not answered in this test: ${method}` } };
}

/** A connected wallet on Arc mainnet: the stand-in provider, Arc's node answered here, and the Wallet window's connect. */
async function connect(page: Page) {
  // Every Arc node viem knows (rpc.mainnet.arc.io and its fallbacks), cross-origin from the page, hence the CORS header.
  await page.route(/^https:\/\/rpc\.([a-z]+\.)?(mainnet|testnet)\.arc\.io(\/|$)/, async (route) => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (route.request().method() !== "POST") return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON() as RpcRequest | RpcRequest[];
    await route.fulfill({ headers, json: Array.isArray(body) ? body.map(answer) : answer(body) });
  });
  await page.addInitScript(
    ({ account, chainId }) => {
      const listeners: Record<string, ((arg: unknown) => void)[]> = {};
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method }: { method: string }) {
          if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
          if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
          if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
          throw Object.assign(new Error("The stand-in wallet signs nothing."), { code: 4001 });
        },
        on(event: string, fn: (arg: unknown) => void) {
          (listeners[event] ??= []).push(fn);
        },
        removeListener(event: string, fn: (arg: unknown) => void) {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        },
      };
    },
    { account: ACCOUNT, chainId: ARC_CHAIN_ID },
  );
  await page.goto("/#app:wallet");
  const wallet = page.getByRole("dialog", { name: "Wallet" });
  await wallet.getByRole("button", { name: "Injected" }).click();
  await expect(wallet.getByText(ACCOUNT)).toBeVisible();
}

async function openApp(page: Page, id: "swap" | "bridge", title: string) {
  await page.goto(`/#app:${id}`);
  const win = page.getByRole("dialog", { name: title });
  await expect(win).toBeVisible();
  return win;
}

test.describe("Swap", () => {
  test("shows the balance of the token sent, and Max fills it in less a little USDC for gas", async ({ page }) => {
    await connect(page);
    const swap = await openApp(page, "swap", "Swap");
    await expect(swap.getByText("Balance: 4.835553 USDC")).toBeVisible();
    await swap.getByRole("button", { name: "Use the maximum amount of USDC" }).click();
    await expect(swap.getByLabel("Amount to send")).toHaveValue("4.785553");

    await swap.getByLabel("Amount to send").fill("5");
    await expect(swap.getByText("That's more than your balance.")).toBeVisible();

    await swap.getByLabel("Token to send").selectOption("EURC");
    await expect(swap.getByText("Balance: 0 EURC")).toBeVisible();
    await expect(swap.getByRole("button", { name: "Use the maximum amount of EURC" })).toBeDisabled();
  });
});

test.describe("Bridge", () => {
  test("from Arc, shows the USDC on Arc, and Max leaves room for gas and the fee on top", async ({ page }) => {
    await connect(page);
    const bridge = await openApp(page, "bridge", "Bridge");
    // Shown so nobody wonders where it went, but Circle has no USDC there, so it can't be picked. The option's own DOM
    // property is checked: toBeDisabled can't be used here, because Playwright follows an element inside a <label> to
    // the label's control, the enabled <select>.
    const bnb = bridge.getByRole("option", { name: /^BNB Smart Chain.*Circle has no USDC there/ });
    await expect(bnb).toHaveJSProperty("disabled", true);
    await bridge.getByRole("button", { name: "From Arc" }).click();
    await expect(bridge.getByText("Balance: 4.835553 USDC on Arc")).toBeVisible();
    await bridge.getByRole("button", { name: "Use the maximum amount of USDC" }).click();
    // (4.835553 - 0.05 for gas) / 1.002, floored: the 0.20% fee is added on top and paid from the same USDC.
    await expect(bridge.getByLabel("Amount to bridge")).toHaveValue("4.776");
    await expect(bridge.getByRole("button", { name: "Bridge", exact: true })).toBeEnabled();

    // 4.83 fits the balance, but 4.83 plus its 0.00966 fee doesn't.
    await bridge.getByLabel("Amount to bridge").fill("4.83");
    await expect(bridge.getByText("With the fee, that's more than your balance on Arc.")).toBeVisible();
    await expect(bridge.getByRole("button", { name: "Bridge", exact: true })).toBeDisabled();
  });

  // Finishing a transfer by its burn hash (apps/bridge/finish.ts). Nothing is looked up or signed here: the field's own
  // check, the stored list of unfinished transfers, and the button's state are what a real browser must show.
  test("offers to finish a transfer by its burn hash, checks the hash, and lists an unfinished transfer the page remembered", async ({ page }) => {
    const burn = "0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b";
    await connect(page);
    await page.evaluate(
      ([key, hash]) =>
        localStorage.setItem(key!, JSON.stringify([{ source: "Arc", dest: "Base", burnTxHash: hash, amount: "9", startedAt: 1_759_480_000_000 }])),
      ["arcos.bridge.unfinished", burn],
    );
    const bridge = await openApp(page, "bridge", "Bridge");
    await expect(bridge.getByRole("heading", { name: "Finish a transfer" })).toBeVisible();

    const unfinished = bridge.getByRole("list", { name: "Unfinished transfers" });
    await expect(unfinished.getByText("9 USDC, Arc → Base")).toBeVisible();
    await expect(unfinished.getByRole("button", { name: /^Finish the transfer 0x7b7b/ })).toBeEnabled();

    const finish = bridge.getByRole("button", { name: "Finish transfer" });
    await expect(finish).toBeDisabled();
    const field = bridge.getByLabel("Burn transaction hash");
    await field.fill("0x1234");
    await expect(bridge.getByText("That isn't a transaction hash: 0x and 64 hex characters.")).toBeVisible();
    await expect(finish).toBeDisabled();
    await field.fill(burn);
    await expect(bridge.getByText("That isn't a transaction hash: 0x and 64 hex characters.")).toBeHidden();
    await expect(finish).toBeEnabled();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("every field in Swap and Bridge is at least 16px, so iOS doesn't zoom in on focus, and nothing scrolls sideways", async ({ page }) => {
    await connect(page);
    for (const [id, title] of [["swap", "Swap"], ["bridge", "Bridge"]] as const) {
      const win = await openApp(page, id, title);
      const fields = win.locator("input, select, textarea");
      await expect(fields.first()).toBeVisible();
      const sizes = await fields.evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
      expect(sizes.length, title).toBeGreaterThan(0);
      for (const size of sizes) expect(size, title).toBeGreaterThanOrEqual(16);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), title).toBe(true);
    }
  });

  test("leaves pinch zoom allowed", async ({ page }) => {
    await page.goto("/");
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*(no|0)/i);
  });
});
