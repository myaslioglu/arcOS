import { describe, expect, it } from "vitest";
import { activeChain } from "@arcos/chain";
import { ROADMAP_APP_ID } from "@arcos/shell/core";
import { APPS } from "@/apps/registry";
import { DESK_ITEMS, deskItems } from "../desk-items";
import { REPO_URL } from "../site";

const REPO = "https://github.com/myaslioglu/arcOS";
const EXPLORER = "https://explorer.arc.io";

describe("deskItems", () => {
  it("puts Help, readme.txt, roadmap.txt, GitHub and Explorer on the desk, in that order", () => {
    expect(deskItems(REPO, EXPLORER).map((i) => [i.label, i.art])).toEqual([
      ["Help", "file"],
      ["readme.txt", "file"],
      ["roadmap.txt", "file"],
      ["GitHub", "link"],
      ["Explorer", "link"],
    ]);
  });

  it("opens the Help guide from Help, an app this site lists live", () => {
    const [help] = deskItems(REPO, EXPLORER);
    expect(help).toMatchObject({ id: "help", blurb: "Start here: a short guide to ArcOS", ext: "GUIDE", hue: "var(--accent)" });
    expect(help.action).toEqual({ kind: "app", appId: "help" });
    const app = APPS.find((m) => m.id === "help");
    expect(app?.comingSoon).toBeFalsy();
    expect(DESK_ITEMS[0]).toBe(DESK_ITEMS.find((i) => i.id === "help"));
  });

  it("keeps the files to four or fewer, and the links too, so each fits a column of the four-row desk", () => {
    const items = deskItems(REPO, EXPLORER);
    expect(items.filter((i) => i.art === "file").length).toBeLessThanOrEqual(4);
    expect(items.filter((i) => i.art === "link").length).toBeLessThanOrEqual(4);
  });

  it("opens About from readme.txt and the Roadmap from roadmap.txt", () => {
    const [, readme, roadmap] = deskItems(REPO, EXPLORER);
    expect(readme.action).toEqual({ kind: "app", appId: "about" });
    expect(readme.ext).toBe("TXT");
    expect(roadmap.action).toEqual({ kind: "app", appId: ROADMAP_APP_ID });
    expect(roadmap.ext).toBe("TXT");
  });

  it("links GitHub to the repository and Explorer to this network's explorer", () => {
    const items = deskItems(REPO, EXPLORER);
    expect(items[3].action).toEqual({ kind: "href", href: REPO });
    expect(items[4].action).toEqual({ kind: "href", href: EXPLORER });
    expect(DESK_ITEMS.find((i) => i.id === "github")?.action).toEqual({ kind: "href", href: REPO_URL });
    expect(DESK_ITEMS.find((i) => i.id === "explorer")?.action).toEqual({
      kind: "href",
      href: activeChain().blockExplorers?.default.url,
    });
  });

  it("leaves a link off when its URL is empty", () => {
    expect(deskItems("", EXPLORER).map((i) => i.id)).toEqual(["help", "readme", "roadmap", "explorer"]);
    expect(deskItems(REPO, "").map((i) => i.id)).toEqual(["help", "readme", "roadmap", "github"]);
  });

  it("colours every item with a token", () => {
    for (const item of deskItems(REPO, EXPLORER)) expect(item.hue, item.id).toMatch(/^var\(--[\w-]+\)$/);
  });
});
