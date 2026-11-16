import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FACTORY = "0x5555555555555555555555555555555555555555";
const USER = "0x2222222222222222222222222222222222222222";

const state = vi.hoisted(() => ({ factory: null as string | null }));

vi.mock("@arcos/chain", async (original) => {
  const real = await original<typeof import("@arcos/chain")>();
  return {
    ...real,
    get ARCOS() {
      return { ...real.ARCOS, testnet: { ...real.ARCOS.testnet!, vestingFactory: state.factory }, mainnet: { ...real.ARCOS.mainnet!, vestingFactory: state.factory } };
    },
  };
});
vi.mock("wagmi", () => ({
  useConnection: () => ({ address: USER, chainId: 5042002 }),
  usePublicClient: () => undefined,
  useWriteContract: () => ({ mutateAsync: async () => "0x" }),
  useReadContracts: () => ({ data: undefined, status: "pending" }),
  useReadContract: () => ({ data: undefined }),
}));
vi.mock("wagmi/actions", () => ({ getConnection: () => ({ chainId: 5042002 }) }));
vi.mock("@/providers/wagmi", () => ({ wagmiConfig: {} }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ isPending: true, isError: false, data: undefined, refetch: async () => undefined }),
}));
vi.mock("@/components/ConnectGate", () => ({ ConnectGate: ({ children }: { children: unknown }) => children }));
vi.mock("@arcos/shell", async (original) => {
  const real = await original<typeof import("@arcos/shell")>();
  return { ...real, useDesktop: () => ({ open: () => undefined, notify: () => undefined }), useDropTarget: () => ({ over: false, props: {} }) };
});

import { AUDIT_NOTE, HOW_IT_WORKS, NOT_DEPLOYED, YOURS_NOTE } from "../copy";
import { Curve } from "../Curve";
import { RunPanel } from "../RunPanel";
import { session } from "../session";
import VestingWindow from "../Window";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const window_ = () => render(createElement(VestingWindow, { winId: "w", params: {} }));

beforeEach(() => {
  state.factory = null;
  session.reset();
});

describe("the window", () => {
  it("says it isn't deployed where the factory has no address", () => {
    expect(window_()).toContain(NOT_DEPLOYED);
  });

  it("shows both tabs, the plain explanation and the audit note where the factory is set", () => {
    state.factory = FACTORY;
    const html = window_();
    expect(html).toContain("New schedule");
    expect(html).toContain("Your schedules");
    expect(html).toContain(HOW_IT_WORKS);
    expect(html).toContain(AUDIT_NOTE);
    expect(html).toContain(YOURS_NOTE);
    expect(html).toContain('aria-label="Duration unit"');
    expect(html).toContain("Create schedule");
  });

  it("uses ArcOS, not another name, and none of the words the copy rules out", () => {
    state.factory = FACTORY;
    const html = window_();
    const text = html.replace(/<[^>]*>/g, " ");
    for (const word of ["safe", "guaranteed", "free", "instant", "ARC.os", "4rc"]) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
    for (const [name, line] of Object.entries({ HOW_IT_WORKS, AUDIT_NOTE, YOURS_NOTE })) {
      expect(line, name).not.toMatch(/\b(safe|guaranteed|free|instant|instantly)\b/i);
    }
  });

  it("states what a schedule can and can't do, and that nothing has been audited", () => {
    expect(HOW_IT_WORKS).toMatch(/can't be cancelled/);
    expect(HOW_IT_WORKS).toMatch(/pays the beneficiary/);
    expect(AUDIT_NOTE).toBe("These contracts have not been audited yet. They run on testnet first, ahead of the audit.");
  });
});

describe("Curve", () => {
  it("draws a path, and marks now only inside the schedule", () => {
    const at = (now: bigint) => render(createElement(Curve, { start: 1000n, duration: 1000n, cliff: 400n, now, label: "curve" }));
    expect(at(1500n)).toContain('data-testid="now-mark"');
    expect(at(1500n)).toMatch(/<path d="M/);
    expect(at(500n)).not.toContain("now-mark");
    expect(at(9999n)).toContain("now-mark");
    expect(at(1500n)).toContain('aria-label="curve"');
  });
  it("draws nothing for an empty schedule", () => {
    expect(render(createElement(Curve, { start: 0n, duration: 0n, cliff: 0n, label: "x" }))).toBe("");
  });
});

describe("RunPanel", () => {
  const rows = [
    { line: 1, address: "0x1111111111111111111111111111111111111111" as const, amount: 5n * 10n ** 18n },
    { line: 2, address: "0x3333333333333333333333333333333333333333" as const, amount: 7n * 10n ** 18n },
  ];
  const done = {
    status: "done" as const,
    token: "0x4444444444444444444444444444444444444444" as const,
    symbol: "TKN",
    decimals: 18,
    rows,
    states: [
      { status: "created" as const, hash: "0xabc", vesting: "0x00000000000000000000000000000000000000a1" as const },
      { status: "failed" as const, message: "Your balance of this token is below this amount." },
    ],
    step: "create" as const,
    leftoverAllowance: 7n * 10n ** 18n as bigint | null,
    result: { states: [], stoppedBecause: null, message: null } as import("../runVesting").VestingRunResult | null,
    approvalMessage: null,
    startedAt: 1,
  };
  const panel = (run: typeof done | (Omit<typeof done, "status"> & { status: "running" })) =>
    render(createElement(RunPanel, { run, onDone: () => undefined, onReuse: () => undefined, onOpenRevoke: () => undefined }));

  it("shows a failed row beside the created one, with the leftover approval and a way to Revoke", () => {
    const html = panel(done);
    expect(html).toContain("1 of 2 schedules created. 1 failed.");
    expect(html).toContain("Created");
    expect(html).toContain("Failed. Your balance of this token is below this amount.");
    expect(html).toContain("View the vesting contract");
    expect(html).toContain("The vesting contract can still take up to 7 TKN from your wallet");
    expect(html).toContain("Open Revoke");
    expect(html).toContain("Put the unfinished rows back in the list");
  });

  it("shows the approval step while it runs", () => {
    const html = panel({ ...done, status: "running", step: "approve", states: [{ status: "waiting" as never }, { status: "waiting" as never }] } as never);
    expect(html).toContain("Approve 12 TKN in your wallet");
    expect(html).not.toContain("Done");
  });

  it("offers no Revoke when no approval is left over", () => {
    expect(panel({ ...done, leftoverAllowance: 0n })).not.toContain("Open Revoke");
    expect(panel({ ...done, leftoverAllowance: null })).not.toContain("Open Revoke");
  });
});
