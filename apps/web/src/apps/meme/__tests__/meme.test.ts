import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appLabel, appTag } from "@arcos/shell/core";
import { APPS, LIVE } from "../../registry";
import { meme } from "../manifest";

describe("Meme", () => {
  it("is a live app in the Trade group, tagged Soon", () => {
    expect(LIVE).toContain(meme);
    expect(APPS.find((m) => m.id === "meme")).toBe(meme);
    expect(meme.category).toBe("trade");
    expect(meme.comingSoon).toBeUndefined();
    expect(meme.tag).toBe("Soon");
    expect(appTag(meme)).toBe("Soon");
    expect(appLabel(meme)).toBe("Meme, soon");
  });

  it("stands with the other Trade apps, after Bridge and Radar", () => {
    const trade = APPS.filter((m) => m.category === "trade").map((m) => m.id);
    expect(trade.indexOf("radar")).toBe(trade.indexOf("bridge") + 1);
    expect(trade.indexOf("meme")).toBe(trade.indexOf("radar") + 1);
  });

  it("opens a window whose body says only Soon.", async () => {
    const { default: Window } = await meme.load();
    const html = renderToStaticMarkup(createElement(Window, { winId: "w-1", params: {} }));
    expect(html.replace(/<[^>]+>/g, "")).toBe("Soon.");
    expect(html).not.toMatch(/<a\b/);
  });

  it("reads nothing from the chain or the network", () => {
    const source = readFileSync(path.join(import.meta.dirname, "..", "Window.tsx"), "utf8");
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toMatch(/wagmi|viem|@arcos\/chain|fetch\(/);
  });
});
