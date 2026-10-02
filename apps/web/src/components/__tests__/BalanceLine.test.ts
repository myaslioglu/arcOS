import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ARC_GAS_RESERVE_UNITS } from "@/lib/balance";
import { BalanceLine, type BalanceLineProps } from "../BalanceLine";

const props = (over: Partial<BalanceLineProps> = {}): BalanceLineProps => ({
  units: 4_835_553n,
  decimals: 6,
  symbol: "USDC",
  onMax: () => {},
  ...over,
});

/** The Max button's element, found in the tree the component returns (no DOM needed). */
function maxButton(p: BalanceLineProps): ReactElement<{ onClick: () => void; disabled: boolean }> {
  const root = BalanceLine(p) as ReactElement<{ children: ReactElement[] }>;
  return root.props.children[1] as ReactElement<{ onClick: () => void; disabled: boolean }>;
}

describe("BalanceLine", () => {
  it("shows 'Balance: X SYMBOL' and a Max button", () => {
    const html = renderToStaticMarkup(createElement(BalanceLine, props()));
    expect(html).toContain("Balance: 4.835553 USDC");
    expect(html).toMatch(/<button[^>]*aria-label="Use the maximum amount of USDC"[^>]*>Max<\/button>/);
  });

  it("names the chain when it is given one", () => {
    expect(renderToStaticMarkup(createElement(BalanceLine, props({ where: "Base" })))).toContain("Balance: 4.835553 USDC on Base");
  });

  it("renders nothing while there is no balance: no wallet, still loading, or a failed read", () => {
    expect(renderToStaticMarkup(createElement(BalanceLine, props({ units: undefined })))).toBe("");
  });

  it("fills in the whole balance when nothing is held back", () => {
    const onMax = vi.fn();
    maxButton(props({ onMax })).props.onClick();
    expect(onMax).toHaveBeenCalledWith("4.835553");
  });

  it("keeps the gas reserve and the fee on top out of Max", () => {
    const onMax = vi.fn();
    maxButton(props({ onMax, max: { reserveUnits: ARC_GAS_RESERVE_UNITS, feeOnTopBps: 20 } })).props.onClick();
    expect(onMax).toHaveBeenCalledWith("4.776");
  });

  it("disables Max when nothing can be spent, and while a session runs", () => {
    expect(maxButton(props({ units: 0n })).props.disabled).toBe(true);
    expect(maxButton(props({ units: 40_000n, max: { reserveUnits: ARC_GAS_RESERVE_UNITS } })).props.disabled).toBe(true);
    expect(maxButton(props({ disabled: true })).props.disabled).toBe(true);
    expect(maxButton(props()).props.disabled).toBe(false);
  });
});
