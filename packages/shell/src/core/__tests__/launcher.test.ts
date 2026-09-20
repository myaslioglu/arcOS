import { describe, expect, it } from "vitest";
import { searchLauncher, type QuickAction } from "../launcher";
import type { AppManifest } from "../manifest";

const app = (id: string, name: string, blurb = ""): AppManifest => ({
  id,
  name,
  blurb,
  icon: (() => null) as unknown as AppManifest["icon"],
  category: "system",
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
});

const list = [app("finder", "Finder", "Your tokens"), app("mint", "Mint", "Create a token"), app("drop", "Drop", "Send to many")];
const names = (q: string, actions: QuickAction[] = []) =>
  searchLauncher(list, q, actions).map((h) => (h.kind === "app" ? h.app.id : h.action.id));

describe("searchLauncher", () => {
  it("lists every app in registry order for an empty query", () => {
    expect(names("")).toEqual(["finder", "mint", "drop"]);
  });

  it("ranks exact, prefix, substring, then blurb matches", () => {
    expect(names("mint")).toEqual(["mint"]);
    expect(names("d")).toEqual(["drop", "finder"]);
    expect(names("token")).toEqual(["finder", "mint"]);
  });

  it("is case-insensitive and trims", () => {
    expect(names("  MIN ")).toEqual(["mint"]);
  });

  it("puts quick actions first", () => {
    const action: QuickAction = { id: "inspect:0x1", title: "Inspect", hint: "", appId: "inspector", params: {} };
    expect(names("zzz", [action])).toEqual(["inspect:0x1"]);
  });
});
