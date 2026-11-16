// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

/**
 * The window's wiring, mounted in jsdom: what its params, a drop, the New lock form and Your locks hand the flows. The
 * chain reads (./hooks, lib/usePositions) answer from `state`, and the flows (./flow) are spies, so nothing reaches a
 * chain or a wallet.
 */

const NOW = 1_800_000_000;
const DAY = 86_400;
const FACTORY = "0x2aA12f98795E7A65072950AfbA9d1E023D398241" as Address;
const WALLET = "0x7e57000000000000000000000000000000000001" as Address;
const OTHER = "0x7e57000000000000000000000000000000000002" as Address;
const TOKEN = "0xBFF22091be481B41C8CA49862653aBA216bAc041" as Address;
const MANAGER = "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B" as Address;
const VAULT = "0x011916e14B8399feC0109f3402d283C71250C33C" as Address;
const P_VAULT = "0x23CD83dBe5FF9dd7165Da1CD4d26F29183E58D40" as Address;
const FEE = 30n * 10n ** 18n;

const state = vi.hoisted(() => ({
  drop: undefined as ((item: unknown) => void) | undefined,
  token: undefined as unknown,
  position: undefined as unknown,
  locks: undefined as unknown,
  locksArgs: [] as unknown[][],
  now: 0,
  opened: [] as Array<[string, Record<string, string> | undefined]>,
  dragged: [] as unknown[],
  pending: { flat: null, lpBps: null, shareBps: null } as Record<string, unknown>,
}));

vi.mock("wagmi", () => ({
  useConnection: () => ({ address: "0x7e57000000000000000000000000000000000001", chainId: 5042002, isConnected: true }),
  useBalance: () => ({ data: { value: 10n ** 22n } }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: async () => undefined }) }));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: (id: string, params?: Record<string, string>) => (state.opened.push([id, params]), true) }),
  useDropTarget: (accepts: string[] | undefined, onDrop: (item: unknown) => void) => {
    state.drop = accepts ? onDrop : undefined;
    return { over: false, props: {} };
  },
  dragSourceProps: (item: unknown) => (state.dragged.push(item), { draggable: true }),
}));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/BalanceLine", () => ({ BalanceLine: () => null }));
vi.mock("@/lib/vault-factory", () => ({ vaultFactoryOf: () => "0x2aA12f98795E7A65072950AfbA9d1E023D398241" }));
vi.mock("@/lib/usePositions", () => ({
  POSITIONS_KEY: "positions",
  useAllowedManagers: () => ({ data: [{ address: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B", name: "Uniswap v4", kind: "v4" }] }),
  usePositions: () => ({ isPending: false, isError: false, data: { managers: [], positions: [], notes: [] } }),
}));
vi.mock("../hooks", () => ({
  LOCKS_KEY: "vault-locks",
  TOKEN_KEY: "vault-token",
  useChainClock: () => ({ now: state.now, fromChain: true, at: () => state.now }),
  useLockFees: () => ({
    data: { feeController: "0x72F853E9E202600c5017B5A060168603c3ed7368", flat: 30n * 10n ** 18n, lpBps: 50n, shareBps: 200n, pending: state.pending },
    isError: false,
    refetch: async () => undefined,
  }),
  useFlowDeps: () => ({ fake: "deps" }),
  useTokenInfo: (token: string | null) => (token ? { isPending: false, isError: false, data: state.token } : { isPending: false, isError: false, data: undefined }),
  usePositionInfo: (manager: string | null) => (manager ? { isPending: false, isError: false, data: state.position } : { isPending: false, data: undefined }),
  useLocks: (...args: unknown[]) => {
    state.locksArgs.push(args);
    return { isPending: false, isError: false, isRefetchError: false, data: state.locks, refetch: async () => undefined };
  },
}));
const runLock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ result: "locked", vault: "0x011916e14B8399feC0109f3402d283C71250C33C", hash: "0x01" })),
);
const runAction = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ result: "done", hash: "0x02", collected: [] })));
vi.mock("../flow", () => ({ runLock, runAction }));

import { vaultSession } from "../session";
import VaultWindow from "../Window";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

async function mount(params: Record<string, string> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(VaultWindow, { winId: "w-1", params })));
}
const panel = (name: "New lock" | "Your locks") => host.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
/** The section the window shows: the pressed one of its two toggles. */
const pressedSection = () => host.querySelector('[role=group][aria-label="Vault sections"] button[aria-pressed=true]')?.textContent;
const buttons = (scope: ParentNode = host) => [...scope.querySelectorAll("button")];
const button = (text: string | RegExp, scope: ParentNode = host) =>
  buttons(scope).find((b) => (typeof text === "string" ? b.textContent === text : text.test(b.textContent ?? "")))!;
const input = (label: string, scope: ParentNode = host) => {
  const labelEl = [...scope.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label))!;
  return scope.querySelector<HTMLInputElement>(`#${CSS.escape(labelEl.htmlFor)}`)!;
};
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (el: HTMLElement) => act(async () => el.click());
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const tokenInfo = { address: TOKEN, symbol: "VTB", name: "Vault Test Beta", decimals: 18, balance: 5000n * 10n ** 18n, allowance: 0n, pair: null };
const tokenLock = {
  vault: VAULT,
  owner: WALLET,
  pendingOwner: null,
  unlockAt: NOW + 90 * DAY,
  kind: "token",
  token: TOKEN,
  symbol: "VTB",
  decimals: 18,
  amount: 1000n * 10n ** 18n,
  pair: null,
};
const positionLock = {
  vault: P_VAULT,
  owner: WALLET,
  pendingOwner: null,
  unlockAt: NOW - DAY,
  kind: "position",
  manager: MANAGER,
  managerName: "Uniswap v4",
  positionKind: "v4",
  tokenId: "328647",
  feeShareBps: 200,
  currency0: TOKEN,
  currency1: "0xF4F40da2D2b7F0a2C5d2d3E113dDfBEB3FfDCa5E",
  symbol0: "VTB",
  symbol1: "VTA",
  decimals0: 18,
  decimals1: 18,
  liquidity: 5n,
  withdrawn: false,
};

beforeEach(() => {
  state.now = NOW;
  state.token = tokenInfo;
  state.position = undefined;
  state.locks = { locks: [], registered: 0, readFromRegistry: 0, notVaults: [] };
  state.locksArgs = [];
  state.opened = [];
  state.dragged = [];
  state.pending = { flat: null, lpBps: null, shareBps: null };
  runLock.mockClear();
  runAction.mockClear();
  vaultSession.forget();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the window", () => {
  it("opens on New lock, says the contracts aren't audited, and says what custody means", async () => {
    await mount();
    expect(pressedSection()).toBe("New lock");
    expect(panel("Your locks").hidden).toBe(true);
    expect(host.textContent).toContain("Not audited yet. These vault contracts run on testnet until their audit is done.");
    expect(panel("New lock").textContent).toContain("The tokens sit in a vault contract. Only the vault's owner can take them out, and only after the unlock date.");
  });

  it("fills the form with a token from its params, and reads it on chain", async () => {
    await mount({ token: TOKEN.toLowerCase() });
    expect(input("Token address").value).toBe(TOKEN);
    expect(panel("New lock").textContent).toContain("VTB · Vault Test Beta");
  });

  it("opens Your locks with a vault from its params or a dropped lock, and reads that vault too", async () => {
    await mount({ vault: VAULT });
    expect(pressedSection()).toBe("Your locks");
    expect(state.locksArgs.at(-1)?.[2]).toEqual([VAULT]);
    await act(async () => state.drop!({ kind: "lock", address: P_VAULT }));
    expect(state.locksArgs.at(-1)?.[2]).toEqual([VAULT, P_VAULT]);
  });

  it("switches to the position form for a dropped position", async () => {
    await mount();
    await act(async () => state.drop!({ kind: "lp-position", manager: MANAGER, tokenId: "328647" }));
    expect(button("Position").getAttribute("aria-pressed")).toBe("true");
    expect(input("Position id").value).toBe("328647");
  });
});

describe("New lock", () => {
  it("hands runLock the token, the amount in its units, the chosen unlock time and the fee it showed", async () => {
    await mount({ token: TOKEN });
    await type(input("Amount"), "1,000.5");
    await click(button("90 days"));
    expect(panel("New lock").textContent).toContain("(in 90 days)");
    await click(button(/^Lock · 30 USDC$/));
    await settle();
    expect(runLock).toHaveBeenCalledTimes(1);
    expect(runLock.mock.calls[0]).toEqual([
      { kind: "token", token: TOKEN, amount: 1_000_500_000_000_000_000_000n, unlockAt: NOW + 90 * DAY, pair: false },
      FACTORY,
      { flat: FEE, lpBps: 50n, shareBps: 200n },
      { fake: "deps" },
      expect.any(Function),
    ]);
    expect(panel("New lock").textContent).toContain("Locked");
    expect(panel("New lock").textContent).toContain(`Vault ${VAULT}`);
  });

  it("says each step in one live region that is always there, and moves focus to the status when the form goes", async () => {
    let finish!: (outcome: unknown) => void;
    runLock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await mount({ token: TOKEN });
    const live = panel("New lock").querySelector<HTMLElement>("[role=status][aria-live=polite]")!;
    expect(live.textContent).toBe("");
    await type(input("Amount"), "1000");
    await click(button("30 days"));
    await click(button(/^Lock · 30 USDC$/));
    expect(panel("New lock").querySelector("[role=status][aria-live=polite]")).toBe(live);
    expect(live.textContent).toMatch(/^Locking 1,000 VTB until .+ UTC\. Checking the fee and the approval…$/);
    expect(document.activeElement?.textContent).toContain("Checking the fee and the approval…");
    await act(async () => finish({ result: "locked", vault: VAULT, hash: "0x01", amount: 995n * 10n ** 18n }));
    expect(live.textContent).toMatch(/^Locked\. 995 VTB is in its vault until .+ UTC\.$/);
    expect(document.activeElement?.textContent).toContain("995 VTB is in its vault");
    await click(button("Lock something else"));
    expect(live.textContent).toBe("");
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("points an invalid field at its message", async () => {
    await mount();
    await type(input("Token address"), "0x12");
    const field = input("Token address");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe("That isn't an address.");
    await type(input("Token address"), TOKEN);
    expect(input("Token address").hasAttribute("aria-invalid")).toBe(false);
  });

  it("warns before the wallet opens about a raise of a fee this lock pays", async () => {
    state.pending = { flat: null, lpBps: { value: 100n, effectiveAt: NOW - 1 }, shareBps: { value: 500n, effectiveAt: NOW + 2 * DAY } };
    state.position = {
      manager: { address: MANAGER, name: "Uniswap v4", kind: "v4" },
      position: { ...positionLock, managerName: "Uniswap v4", kind: "v4", tokenId: "7", fee: 3000, owed: false, hooks: null },
    };
    await mount({ manager: MANAGER, tokenId: "7" });
    // A position pays the share of collected fees, not the LP share.
    expect(panel("New lock").textContent).toContain("ArcOS's share of collected fees can rise to 5% from ");
    expect(panel("New lock").textContent).not.toContain("LP token lock can rise");
  });

  it("says what is missing instead of locking: no date, no amount, more than the balance", async () => {
    await mount({ token: TOKEN });
    await click(button(/^Lock · 30 USDC$/));
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Pick an unlock date.");
    await click(button("30 days"));
    await click(button(/^Lock · 30 USDC$/));
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Enter an amount.");
    await type(input("Amount"), "5001");
    await click(button(/^Lock · 30 USDC$/));
    expect(host.querySelector("[role=alert]")?.textContent).toBe("That's more than your balance.");
    expect(runLock).not.toHaveBeenCalled();
  });

  it("refuses a position the factory would refuse, before the wallet opens, in the contract's words", async () => {
    state.position = {
      manager: { address: MANAGER, name: "Uniswap v4", kind: "v4" },
      position: { ...positionLock, manager: MANAGER, kind: "v4", tokenId: "7", fee: 3000, owed: false, hooks: "0x0000000000000000000000000000000000A00800" },
    };
    await mount({ manager: MANAGER, tokenId: "7" });
    expect(panel("New lock").textContent).toContain("This position is in a Uniswap v4 pool with hooks, which can't be locked.");
    await click(button("1 year"));
    await click(button(/^Lock · 30 USDC$/));
    expect(host.querySelector("[role=alert]")?.textContent).toBe("This position is in a Uniswap v4 pool with hooks, which can't be locked.");
    expect(runLock).not.toHaveBeenCalled();
  });

  it("locks a position by its manager and id", async () => {
    state.position = {
      manager: { address: MANAGER, name: "Uniswap v4", kind: "v4" },
      position: { ...positionLock, managerName: "Uniswap v4", kind: "v4", tokenId: "7", fee: 3000, owed: false, hooks: null },
    };
    await mount({ manager: MANAGER, tokenId: "7" });
    expect(panel("New lock").textContent).toContain("ArcOS keeps 2% of the trading fees you collect from the vault.");
    await click(button("180 days"));
    await click(button(/^Lock · 30 USDC$/));
    await settle();
    expect(runLock.mock.calls[0]?.[0]).toEqual({ kind: "position", manager: MANAGER, tokenId: 7n, unlockAt: NOW + 180 * DAY });
  });
});

describe("Your locks", () => {
  const rowOf = (text: string) => [...panel("Your locks").querySelectorAll("li")].find((li) => li.textContent?.includes(text))!;

  it("lists each lock as a file, with what its owner can do, and Withdraw only from the unlock date", async () => {
    state.locks = { locks: [tokenLock, positionLock], registered: 2, readFromRegistry: 2, notVaults: [] };
    await mount({ vault: VAULT });
    const token = rowOf("1,000 VTB");
    const position = rowOf("Uniswap v4 #328647");
    expect(buttons(token).map((b) => [b.textContent, b.disabled])).toEqual([
      ["Extend", false],
      ["Withdraw", true],
      ["Transfer", false],
    ]);
    expect(buttons(position).map((b) => [b.textContent, b.disabled])).toEqual([
      ["Extend", false],
      ["Collect fees", false],
      ["Withdraw", false],
      ["Transfer", false],
    ]);
    expect(token.querySelector(`a[href="/t/${TOKEN}"]`)?.textContent).toBe("Proof: VTB");
    expect(token.querySelector(`a[href$="/address/${VAULT}"]`)).not.toBeNull();
    expect(state.dragged).toContainEqual({ kind: "lock", address: VAULT });
    await click(button("Withdraw", position));
    await settle();
    expect(runAction).toHaveBeenCalledWith(positionLock, { kind: "withdraw" }, { fake: "deps" }, expect.any(Function));
  });

  it("extends by a preset from the current unlock time", async () => {
    state.locks = { locks: [tokenLock], registered: 1, readFromRegistry: 1, notVaults: [] };
    await mount({ vault: VAULT });
    const row = rowOf("1,000 VTB");
    await click(button("Extend", row));
    await click(button("+30 days", row));
    await click(button("Extend the lock", row));
    await settle();
    expect(runAction).toHaveBeenCalledWith(tokenLock, { kind: "extend", unlockAt: tokenLock.unlockAt + 30 * DAY }, { fake: "deps" }, expect.any(Function));
  });

  it("starts a handover only to a real other address, and shows it waiting, with a way to cancel", async () => {
    state.locks = { locks: [tokenLock], registered: 1, readFromRegistry: 1, notVaults: [] };
    await mount({ vault: VAULT });
    let row = rowOf("1,000 VTB");
    await click(button("Transfer", row));
    await type(input("New owner", row), WALLET);
    await click(button("Start the handover", row));
    expect(row.querySelector("[role=alert]")?.textContent).toBe("That's already the owner.");
    await type(input("New owner", row), OTHER);
    await click(button("Start the handover", row));
    await settle();
    expect(runAction).toHaveBeenLastCalledWith(tokenLock, { kind: "transfer", to: OTHER }, { fake: "deps" }, expect.any(Function));

    state.locks = { locks: [{ ...tokenLock, pendingOwner: OTHER }], registered: 1, readFromRegistry: 1, notVaults: [] };
    // The list is read again (in the app, after the transaction): a render with fresh params stands in for that here.
    await act(async () => root.render(createElement(VaultWindow, { winId: "w-1", params: { vault: VAULT } })));
    row = rowOf("1,000 VTB");
    expect(row.textContent).toContain("Handing to 0x7e57…0002: waiting for them to accept.");
    await click(button("Cancel the handover", row));
    await settle();
    expect(runAction).toHaveBeenLastCalledWith(expect.objectContaining({ vault: VAULT }), { kind: "cancel" }, { fake: "deps" }, expect.any(Function));
    expect(rowOf("1,000 VTB").textContent).toContain("Handover cancelled. The vault stays yours.");
  });

  it("points the new owner's field at what is wrong with it", async () => {
    state.locks = { locks: [tokenLock], registered: 1, readFromRegistry: 1, notVaults: [] };
    await mount({ vault: VAULT });
    const row = rowOf("1,000 VTB");
    await click(button("Transfer", row));
    await type(input("New owner", row), "0x0000000000000000000000000000000000000000");
    await click(button("Start the handover", row));
    const field = input("New owner", row);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe("The new owner can't be the zero address.");
  });

  it("offers Accept for a vault being handed to the wallet, and nothing for one it has no part in", async () => {
    state.locks = {
      locks: [
        { ...tokenLock, owner: OTHER, pendingOwner: WALLET },
        { ...positionLock, owner: OTHER },
      ],
      registered: 0,
      readFromRegistry: 0,
      notVaults: [],
    };
    await mount({ vault: VAULT });
    const incoming = rowOf("1,000 VTB");
    expect(incoming.textContent).toContain("0x7e57…0002 started handing this vault to you.");
    await click(button("Accept ownership", incoming));
    await settle();
    expect(runAction).toHaveBeenCalledWith(expect.objectContaining({ vault: VAULT }), { kind: "accept" }, { fake: "deps" }, expect.any(Function));
    const other = rowOf("Uniswap v4 #328647");
    expect(buttons(other)).toEqual([]);
    expect(other.textContent).toContain("You don't own this vault, so you can only look.");
  });

  it("names an address the factory doesn't know as not an ArcOS vault", async () => {
    state.locks = { locks: [], registered: 0, readFromRegistry: 0, notVaults: [OTHER] };
    await mount({ vault: OTHER });
    expect(panel("Your locks").querySelector("[role=alert]")?.textContent).toBe("Not an ArcOS vault: 0x7e57…0002.");
  });
});
