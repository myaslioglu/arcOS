import { readFileSync } from "node:fs";
import path from "node:path";
import { Lock } from "lucide-react";
import { describe, expect, it } from "vitest";
import { CATEGORY_ORDER, folderContents, stageLabel, type AppManifest } from "@arcos/shell/core";
import { APPS, LIVE, appsFor } from "../../registry";
import { SOON } from "../../soon";
import {
  APPS_LEAD,
  APP_GUIDE,
  FAUCET_URL,
  FOOTER,
  GLOSSARY,
  MAINNET_ONLY,
  NOT_ADVICE,
  SECTIONS,
  WHAT_IS,
  startSteps,
  tips,
} from "../copy";
import { guideGroups } from "../guide";

const ids = (groups: ReturnType<typeof guideGroups>) => groups.flatMap((g) => g.cards.map((c) => c.app.id));
const card = (groups: ReturnType<typeof guideGroups>, id: string) => groups.flatMap((g) => g.cards).find((c) => c.app.id === id);

describe("guideGroups", () => {
  it("lists every app the site lists, folder by folder in the desktop's order, less Help itself and the tagged teaser", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      const list = appsFor(network);
      const groups = guideGroups(list, network);
      const expected = CATEGORY_ORDER.flatMap((c) => folderContents(list, c))
        .filter((m) => m.id !== "help" && (m.comingSoon || !m.tag))
        .map((m) => m.id);
      expect(ids(groups), network).toEqual(expected);
      expect(groups.map((g) => g.category), network).toEqual(CATEGORY_ORDER.filter((c) => folderContents(list, c).length > 0));
      expect(groups.map((g) => g.label), network).toEqual(groups.map((g) => ({ system: "System", trust: "Trust", create: "Create", trade: "Trade" })[g.category]));
      expect(ids(groups), network).not.toContain("help");
      expect(ids(groups), network).not.toContain("meme");
    }
  });

  it("follows this build's registry", () => {
    expect(ids(guideGroups(APPS, "testnet"))).toEqual(
      CATEGORY_ORDER.flatMap((c) => folderContents(APPS, c)).filter((m) => m.id !== "help" && !m.tag).map((m) => m.id),
    );
  });

  it("shows Vault and Vesting as coming on mainnet, with their stage and their grey stand-in's first sentence", () => {
    const groups = guideGroups(appsFor("mainnet"), "mainnet");
    for (const id of ["vault", "vesting"]) {
      const grey = SOON.find((m) => m.id === id)!;
      expect(card(groups, id), id).toMatchObject({ what: grey.details![0], when: APP_GUIDE[id].when, stage: stageLabel(grey.release), note: null });
      expect(card(groups, id)?.stage).toBe("After the audit");
    }
  });

  it("shows Vault and Vesting live on testnet, where their contracts are set, with Help's own lines", () => {
    const groups = guideGroups(appsFor("testnet"), "testnet");
    for (const id of ["vault", "vesting"]) {
      expect(card(groups, id), id).toMatchObject({ what: APP_GUIDE[id].what, when: APP_GUIDE[id].when, stage: null, note: null });
      expect(card(groups, id)?.app).toBe(LIVE.find((m) => m.id === id));
    }
  });

  it("marks the apps that read mainnet data as mainnet only on the testnet site, and nowhere else", () => {
    const mainnetOnly = Object.entries(APP_GUIDE)
      .filter(([, g]) => g.mainnetOnly)
      .map(([id]) => id);
    expect(mainnetOnly.sort()).toEqual(["radar", "stats", "watchdog"]);
    const testnet = guideGroups(appsFor("testnet"), "testnet");
    const mainnet = guideGroups(appsFor("mainnet"), "mainnet");
    for (const id of mainnetOnly) {
      expect(card(testnet, id)?.note, id).toBe(MAINNET_ONLY);
      expect(card(mainnet, id)?.note, id).toBeNull();
    }
    expect(testnet.flatMap((g) => g.cards).filter((c) => c.note !== null).map((c) => c.app.id).sort()).toEqual(mainnetOnly.sort());
  });

  it("falls back to an app's blurb for an app Help has no line for", () => {
    const stranger: AppManifest = {
      id: "stranger",
      name: "Stranger",
      blurb: "Does a new thing",
      icon: Lock,
      category: "create",
      window: { w: 400, h: 300 },
      load: async () => ({ default: () => null }),
      requiresWallet: false,
      release: "r0",
    };
    expect(card(guideGroups([stranger], "mainnet"), "stranger")).toMatchObject({ what: "Does a new thing", when: null, stage: null, note: null });
  });

  it("has a line for every app on either site, and none for an app that doesn't exist", () => {
    const listed = new Set([...appsFor("mainnet"), ...appsFor("testnet")].filter((m) => m.id !== "help" && (m.comingSoon || !m.tag)).map((m) => m.id));
    expect(Object.keys(APP_GUIDE).sort()).toEqual([...listed].sort());
    const known = new Set([...LIVE, ...SOON].map((m) => m.id));
    for (const id of Object.keys(APP_GUIDE)) expect(known.has(id), id).toBe(true);
  });
});

describe("the guide's steps and tips, per network", () => {
  it("names the network as the switch button does, and sends testnet visitors to the faucet", () => {
    const testnet = startSteps("testnet", "Arc Testnet");
    expect(testnet.map((s) => s.key)).toEqual(["wallet", "network", "usdc", "connect"]);
    expect(testnet[1]).toMatchObject({ title: "Switch to Arc Testnet" });
    expect(testnet[1].text).toContain("a Switch to Arc Testnet button");
    expect(testnet[2].link).toEqual({ label: "Open Circle's faucet", href: FAUCET_URL });
    expect(testnet[2].text).toContain("Test tokens have no value.");
    expect(testnet[2].app).toBeUndefined();
  });

  it("on mainnet, points at Bridge for USDC and says nothing of test tokens", () => {
    const mainnet = startSteps("mainnet", "Arc");
    expect(mainnet[1].title).toBe("Switch to Arc");
    expect(mainnet[2]).toMatchObject({ app: { label: "Open Bridge", id: "bridge" } });
    expect(mainnet[2].link).toBeUndefined();
    expect(mainnet.map((s) => `${s.title} ${s.text}`).join(" ")).not.toMatch(/\btest\b|faucet/i);
    expect(mainnet[3].app).toEqual({ label: "Open Wallet", id: "wallet" });
  });

  it("says the keys stay with the wallet's owner", () => {
    expect(startSteps("mainnet", "Arc")[0].text).toContain("ArcOS never sees or holds your keys.");
  });

  it("adds the testnet tip on the testnet site only", () => {
    expect(tips("testnet").map((t) => t.key)).toEqual(["phrase", "read", "inspect", "revoke", "testnet"]);
    expect(tips("mainnet").map((t) => t.key)).toEqual(["phrase", "read", "inspect", "revoke"]);
    expect(tips("mainnet")[0].text).toContain("ArcOS will never ask for it");
  });

  it("says what ArcOS is in two sentences: tools for tokens on Arc, gas paid in USDC", () => {
    expect(WHAT_IS).toHaveLength(2);
    expect(WHAT_IS[0]).toMatch(/^ArcOS is .*tokens on Arc/);
    expect(WHAT_IS[1]).toMatch(/gas.*USDC/);
  });

  it("names the five sections, and explains the words the apps use", () => {
    expect(SECTIONS.map((s) => s.heading)).toEqual(["What is ArcOS?", "Get started", "What can I do here?", "Protect your wallet", "Words to know"]);
    expect(GLOSSARY.map((g) => g.term)).toEqual(["Wallet", "Token", "Gas", "Approval", "LP token", "Lock", "Vesting"]);
  });
});

/** Every sentence Help can show, on either network. */
function allCopy(): string[] {
  const lines: string[] = [...WHAT_IS, APPS_LEAD, NOT_ADVICE, MAINNET_ONLY, FOOTER, ...SECTIONS.flatMap((s) => [s.heading, s.jump])];
  for (const network of ["mainnet", "testnet"] as const) {
    for (const step of startSteps(network, network === "mainnet" ? "Arc" : "Arc Testnet")) {
      lines.push(step.title, step.text, ...(step.link ? [step.link.label] : []), ...(step.app ? [step.app.label] : []));
    }
    lines.push(...tips(network).map((t) => t.text));
    for (const g of guideGroups(appsFor(network), network)) for (const c of g.cards) lines.push(c.what, ...(c.when ? [c.when] : []));
  }
  for (const g of Object.values(APP_GUIDE)) lines.push(g.what, g.when);
  for (const g of GLOSSARY) lines.push(g.term, g.meaning);
  return lines;
}

const HIDDEN = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u2028\u2029]/;

describe("Help's copy", () => {
  it("promises nothing a contract can't keep, and gives no advice to buy", () => {
    for (const line of allCopy()) expect(line).not.toMatch(/\b(safe(ly|ty)?|guarantee[ds]?|free|instant(ly)?|no risk|risk-free|profit)\b/i);
  });

  it("claims no more than a lock can hold: a lock can't be withdrawn early, which isn't the same as nothing can move", () => {
    for (const line of allCopy()) expect(line).not.toMatch(/\bnobody can\b|can't be pulled|can't be moved/i);
    expect(GLOSSARY.find((g) => g.term === "Lock")?.meaning).toBe(
      "Tokens kept in a contract until a date, so they can't be withdrawn early. A lock is only as sound as its token.",
    );
  });

  it("states no fee amount: each app shows its own before you sign", () => {
    for (const line of allCopy()) expect(line).not.toMatch(/\d\s*(USDC|%)|\bUSDC\s*\d/);
  });

  it("names the product ArcOS, says nothing of a meme app, and uses no em dash or hidden character", () => {
    for (const line of allCopy()) {
      expect(line).not.toMatch(/4rc\.OS|ARC\.os|\bmeme\b/i);
      expect(line).not.toMatch(/[\u2014\u2013]/);
      expect(line).not.toMatch(HIDDEN);
    }
  });

  it("writes the sentences whole: a capital first, a stop last", () => {
    const sentences = [...WHAT_IS, APPS_LEAD, NOT_ADVICE, FOOTER, ...Object.values(APP_GUIDE).flatMap((g) => [g.what, g.when]), ...GLOSSARY.map((g) => g.meaning)];
    for (const line of sentences) expect(line).toMatch(/^[A-Z].*\.$/);
    for (const g of Object.values(APP_GUIDE)) expect(g.when).toMatch(/^Use it /);
  });

  it("keeps the folder's own source to the same rules, comments included", () => {
    const dir = path.resolve(import.meta.dirname, "..");
    for (const file of ["copy.ts", "guide.ts", "Window.tsx", "Art.tsx", "manifest.ts"]) {
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(text, file).not.toMatch(HIDDEN);
      expect(text, file).not.toMatch(/\u2014/);
      expect(text, file).not.toMatch(/\bmeme\b/i);
    }
  });
});
