// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeChain } from "@arcos/chain";
import type { Approval, ApprovalsAnswer } from "@/lib/approvals";

/**
 * The window's wiring, mounted in jsdom: what a click on Revoke, on Revoke all, or a drop on the trash area hands the
 * revoke session. The flow itself (flow.ts) is replaced by a spy, so nothing reaches a chain or a wallet.
 */

const state = vi.hoisted(() => ({
  /** What useConnection answers to the window itself and to its approval list; each falls back to `address`. */
  accounts: {} as { window?: string; list?: string },
  address: undefined as string | undefined,
  data: undefined as ApprovalsAnswer | undefined,
  drop: undefined as ((item: unknown) => void) | undefined,
}));
vi.mock("wagmi", () => ({
  useConnection: () => {
    // The caller, read off the stack: the approval list is the only component in Window.tsx named ApprovalList.
    const caller = /\bApprovalList\b/.test(new Error().stack ?? "") ? "list" : "window";
    return { address: caller in state.accounts ? state.accounts[caller] : state.address, chainId: 1 };
  },
  usePublicClient: () => ({ fake: "client" }),
  useWriteContract: () => ({ mutateAsync: async () => "0x" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ isPending: false, isLoadingError: false, isRefetchError: false, data: state.data, refetch: async () => undefined }),
}));
vi.mock("@arcos/shell", () => ({
  useDesktop: () => ({ open: () => true }),
  dragSourceProps: () => ({}),
  useDropTarget: (accepts: string[] | undefined, onDrop: (item: unknown) => void) => {
    state.drop = accepts ? onDrop : undefined;
    return { over: false, props: {} };
  },
}));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));
const revokeStep = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock("../flow", () => ({ revokeStep }));

import { forgetRevokes } from "../rows";
import { revokeSession } from "../session";
import RevokeWindow from "../Window";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const NFT = "0x4444444444444444444444444444444444444444";
const SPENDER = "0x5555555555555555555555555555555555555555";

const erc20: Approval = {
  kind: "erc20",
  token: TOKEN,
  symbol: "AAA",
  name: "Token A",
  decimals: 18,
  spender: SPENDER,
  spenderLabel: null,
  allowance: "5",
  lastApprovalBlock: 10,
};
const nft: Approval = { ...erc20, kind: "erc721", token: NFT, symbol: "PUNK", decimals: null, allowance: "1", tokenId: "7" };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(RevokeWindow, { winId: "w-1", params: {} })));
}
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
/** Lets the run finish (the spy answers at once) and the window settle. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  state.accounts = {};
  state.address = OWNER;
  state.data = { approvals: [erc20, nft], truncated: false };
  state.drop = undefined;
  revokeStep.mockClear();
  revokeSession.forget();
  forgetRevokes();
  vi.spyOn(revokeSession, "run");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Revoke's window wiring", () => {
  it("hands a row's Revoke click to the session as that row, run on the site's chain for the owner", async () => {
    await mount();
    const revokes = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Revoke");
    expect(revokes).toHaveLength(2);
    await act(async () => revokes[1]!.click());
    expect(revokeSession.run).toHaveBeenCalledTimes(1);
    expect(revokeSession.run).toHaveBeenCalledWith(OWNER, [[nft]], expect.any(Function), expect.any(Function));
    await settle();
    expect(revokeStep).toHaveBeenCalledTimes(1);
    expect(revokeStep).toHaveBeenCalledWith(
      [nft],
      expect.objectContaining({ owner: OWNER, account: OWNER, chainId: activeChain().id, walletChainId: 1, client: { fake: "client" } }),
    );
  });

  it("hands Revoke all every listed row, in list order", async () => {
    await mount();
    await act(async () => button("Revoke all (2)").click());
    expect(revokeSession.run).toHaveBeenCalledWith(OWNER, [[erc20], [nft]], expect.any(Function), expect.any(Function));
    await settle();
    expect(revokeStep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([[erc20], [nft]]);
  });

  it("revokes the listed row a drop names, and nothing for a drop naming a row that isn't listed", async () => {
    await mount();
    expect(state.drop).toBeTypeOf("function");
    await act(async () => state.drop!({ kind: "approval", approval: "erc20", token: OTHER, spender: SPENDER }));
    expect(revokeSession.run).not.toHaveBeenCalled();
    await act(async () => state.drop!({ kind: "approval", approval: "erc721", token: NFT, spender: SPENDER, tokenId: "7" }));
    expect(revokeSession.run).toHaveBeenCalledTimes(1);
    const [owner, steps] = vi.mocked(revokeSession.run).mock.calls[0]!;
    expect(owner).toBe(OWNER);
    // The row as listed, not what the drag claimed.
    expect(steps[0]![0]).toBe(nft);
    await settle();
    expect(revokeStep).toHaveBeenCalledWith([nft], expect.objectContaining({ chainId: activeChain().id }));
  });

  it("starts nothing when the connected wallet isn't the owner whose list is shown", async () => {
    // The window decides the list is the owner's own; the list then finds another wallet connected.
    state.accounts = { window: OWNER, list: OTHER };
    await mount();
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Revoke")!.click());
    await act(async () => state.drop?.({ kind: "approval", approval: "erc20", token: TOKEN, spender: SPENDER }));
    expect(revokeSession.run).not.toHaveBeenCalled();
    expect(revokeStep).not.toHaveBeenCalled();
  });
});

describe("Revoke's window wiring, once the wallet has signed", () => {
  it("passes the flow a way to say so, and the row's button then waits for confirmation", async () => {
    let signed: (() => void) | undefined;
    let finish: (() => void) | undefined;
    revokeStep.mockImplementationOnce(async (...args: unknown[]) => {
      signed = (args[1] as { onSent?: () => void }).onSent;
      await new Promise<void>((r) => (finish = r));
      return [];
    });
    await mount();
    await act(async () => button("Revoke all (2)").click());
    await settle();
    expect(button("Waiting for your wallet…")).toBeDefined();
    expect(signed).toBeTypeOf("function");
    await act(async () => signed!());
    expect(button("Waiting for confirmation…")).toBeDefined();
    expect(button("Waiting for your wallet…")).toBeUndefined();
    await act(async () => revokeSession.stop());
    finish!();
    await settle();
  });
});
