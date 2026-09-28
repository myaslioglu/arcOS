import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW, DESKTOP_VIEWS, VIEW_STORAGE_KEY, folderContents, itemCount, parseStoredView } from "../desk";
import type { AppManifest } from "../manifest";

const app = (id: string, category: AppManifest["category"], over: Partial<AppManifest> = {}): AppManifest => ({
  id,
  name: id,
  blurb: "",
  icon: (() => null) as unknown as AppManifest["icon"],
  category,
  window: { w: 400, h: 300 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  release: "r0",
  ...over,
});

describe("parseStoredView", () => {
  it("keeps a stored folders or trays choice", () => {
    expect(parseStoredView("folders")).toBe("folders");
    expect(parseStoredView("trays")).toBe("trays");
  });

  it("reads anything else, a missing value included, as the folders default", () => {
    for (const raw of [null, "", "Folders", "list", " trays", '"trays"', "undefined"]) {
      expect(parseStoredView(raw)).toBe("folders");
    }
  });
});

describe("the view preference", () => {
  it("lives under arcos-view and offers folders, then trays", () => {
    expect(VIEW_STORAGE_KEY).toBe("arcos-view");
    expect(DESKTOP_VIEWS).toEqual(["folders", "trays"]);
    expect(DEFAULT_VIEW).toBe("folders");
  });
});

describe("folderContents", () => {
  it("keeps a category's apps in registry order, grey ones included", () => {
    const list = [app("finder", "system"), app("inspector", "trust"), app("wallet", "system"), app("revoke", "system", { comingSoon: true })];
    expect(folderContents(list, "system").map((m) => m.id)).toEqual(["finder", "wallet", "revoke"]);
    expect(folderContents(list, "trade")).toEqual([]);
  });
});

describe("itemCount", () => {
  it("counts in words", () => {
    expect(itemCount(0)).toBe("0 items");
    expect(itemCount(1)).toBe("1 item");
    expect(itemCount(5)).toBe("5 items");
  });
});
