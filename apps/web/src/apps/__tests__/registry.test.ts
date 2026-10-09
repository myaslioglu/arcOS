import { Lock } from "lucide-react";
import { describe, expect, it } from "vitest";
import { ARCOS } from "@arcos/chain";
import type { AppManifest } from "@arcos/shell";
import { CATEGORY_HUE, appHue, stageLabel } from "@arcos/shell/core";
import { APPS, LIVE, NEEDS_CONTRACT, appsFor, contractAddress } from "../registry";
import { SOON } from "../soon";

const grey = APPS.filter((m) => m.comingSoon);

// What dates a sentence: a year, a month or a quarter. Case-sensitive, so the modal verb "may" isn't read as May.
const DATES = /\b(?:19|20)\d\d\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4])\b/;

describe("APPS", () => {
  it("gives every registered app a hue, coming-soon apps included", () => {
    expect(APPS.some((m) => m.comingSoon)).toBe(true);
    for (const m of APPS) {
      expect(appHue(m), m.id).toMatch(/^var\(--[\w-]+\)$/);
      expect(appHue(m), m.id).toBe(CATEGORY_HUE[m.category]);
    }
  });

  it("gives every grey app two or three sentences on what it will do, and no dates", () => {
    for (const m of grey) {
      expect(m.details?.length ?? 0, m.id).toBeGreaterThanOrEqual(2);
      expect(m.details?.length ?? 0, m.id).toBeLessThanOrEqual(3);
      for (const line of m.details ?? []) {
        expect(line, m.id).toMatch(/^[A-Z][^!]*\.$/);
        expect(line, m.id).not.toMatch(DATES);
      }
    }
  });

  it("gives every grey app a stage", () => {
    for (const m of grey) expect(stageLabel(m.release), m.id).not.toBeNull();
  });
});

// Inspector reports evidence and "N of M checks pass", never a number that ranks a token, so no grey app may promise one.
const SCORE = /\bscor/i;
/** What a line may say about a score: that there is none. */
const withoutTheDenial = (line: string) => line.replaceAll("never a score", "");

describe("the no-score rule", () => {
  it("keeps every grey app's blurb and details free of a score, except to say there is none", () => {
    for (const m of grey) {
      expect(m.blurb, m.id).not.toMatch(SCORE);
      for (const line of m.details ?? []) expect(withoutTheDenial(line), m.id).not.toMatch(SCORE);
    }
  });

  it("catches a score in any form, and lets the denial through", () => {
    for (const line of ["Scored by Inspector.", "Will score each token.", "A trust score.", "Scores every token.", "Scoring is done."]) {
      expect(withoutTheDenial(line), line).toMatch(SCORE);
    }
    expect(withoutTheDenial("Evidence, never a score.")).not.toMatch(SCORE);
  });

  it("lists Radar as a live app with its blurb", () => {
    const radar = LIVE.find((m) => m.id === "radar");
    expect(radar).toMatchObject({ blurb: "New tokens, each with Inspector's checks", category: "trade", release: "r1" });
    expect(radar?.comingSoon).toBeFalsy();
    expect(SOON.some((m) => m.id === "radar")).toBe(false);
    expect(appsFor("mainnet").filter((m) => m.id === "radar")).toHaveLength(1);
    expect(appsFor("testnet").filter((m) => m.id === "radar")).toHaveLength(1);
  });

  it("lists Watchdog as a live app after Inspector, on both networks, and not among the gated apps", () => {
    const watchdog = LIVE.find((m) => m.id === "watchdog");
    expect(watchdog).toMatchObject({
      blurb: "Alerts when a token you hold changes",
      category: "trust",
      release: "r1",
      acceptsDrop: ["token"],
      requiresWallet: true,
      window: { w: 480, h: 560 },
    });
    expect(watchdog?.comingSoon).toBeFalsy();
    expect(watchdog?.instanceKey).toBeUndefined();
    expect(LIVE.indexOf(watchdog!)).toBe(LIVE.findIndex((m) => m.id === "inspector") + 1);
    expect(SOON.some((m) => m.id === "watchdog")).toBe(false);
    expect(Object.hasOwn(NEEDS_CONTRACT, "watchdog")).toBe(false);
    expect(appsFor("mainnet").filter((m) => m.id === "watchdog")).toHaveLength(1);
    expect(appsFor("testnet").filter((m) => m.id === "watchdog")).toHaveLength(1);
  });
});

describe("the no-dates rule", () => {
  it("catches a year, any month, and a quarter", () => {
    for (const line of ["Ships in 2027.", "Ships in January.", "Ships in May.", "Ships in December.", "Ships in Q3."]) {
      expect(line, line).toMatch(DATES);
    }
  });

  it("does not take the modal verb for the month", () => {
    for (const line of ["It may need an audit first.", "Will show what may be revoked."]) {
      expect(line, line).not.toMatch(DATES);
    }
  });
});

// D6: an app that acts through one of 4rc.OS's own custodial contracts is live only on a network where @arcos/chain's
// ARCOS names that contract. Elsewhere its grey stand-in shows, so nothing disappears and nothing unaudited is offered.
describe("the registry, gated per network (D6)", () => {
  const ADDRESS = "0x1111111111111111111111111111111111111111";
  const ids = (apps: AppManifest[]) => apps.map((m) => m.id);
  const liveVault: AppManifest = {
    id: "vault",
    name: "Vault",
    blurb: "Lock liquidity and team tokens",
    icon: Lock,
    category: "trust",
    window: { w: 640, h: 520 },
    load: async () => ({ default: () => null }),
    requiresWallet: true,
    release: "r2",
  };

  it("names the contract each gated app needs: Vault the VaultFactory, Vesting the VestingFactory", () => {
    expect(NEEDS_CONTRACT).toEqual({ vault: "vaultFactory", vesting: "vestingFactory" });
  });

  it("has a grey stand-in for every gated app, so it stays listed where its contract isn't set", () => {
    for (const id of Object.keys(NEEDS_CONTRACT)) {
      expect(SOON.find((m) => m.id === id)?.comingSoon, id).toBe(true);
    }
  });

  it("lists the same apps on both networks today, since no network has a gated contract yet", () => {
    expect(ids(appsFor("mainnet"))).toEqual(ids([...LIVE, ...SOON]));
    expect(ids(appsFor("testnet"))).toEqual(ids([...LIVE, ...SOON]));
    expect(ids(APPS)).toEqual(ids([...LIVE, ...SOON]));
  });

  it("lists a gated app live where its contract has an address, in place of its grey stand-in", () => {
    const apps = appsFor("testnet", { live: [...LIVE, liveVault], contracts: { vaultFactory: ADDRESS } });
    const vault = apps.filter((m) => m.id === "vault");
    expect(vault).toEqual([liveVault]);
    expect(ids(apps).filter((id) => id === "vesting")).toEqual(["vesting"]); // still grey: its factory isn't set
    expect(apps.find((m) => m.id === "vesting")?.comingSoon).toBe(true);
  });

  it("keeps a gated app grey where its contract is null, missing, or not an address", () => {
    for (const contracts of [null, {}, { vaultFactory: null }, { vaultFactory: "0x1234" }, { vaultFactory: 42 }]) {
      const apps = appsFor("mainnet", { live: [...LIVE, liveVault], contracts });
      expect(apps.filter((m) => m.id === "vault").map((m) => m.comingSoon), JSON.stringify(contracts)).toEqual([true]);
    }
  });

  it("never lists a gated app live where its contract isn't set, even with no grey stand-in", () => {
    const apps = appsFor("mainnet", { live: [liveVault], soon: [], contracts: null });
    expect(apps).toEqual([]);
  });

  it("reads each network's own contracts from ARCOS by default", () => {
    const withVault = { ...ARCOS.testnet, vaultFactory: ADDRESS };
    expect(contractAddress(withVault, "vaultFactory")).toBe(ADDRESS);
    expect(contractAddress(ARCOS.mainnet, "vaultFactory")).toBeNull();
    expect(contractAddress(null, "vaultFactory")).toBeNull();
  });

  // The rule of D6 as data: until the audit gates are passed (task C6), mainnet names none of these contracts. C6
  // changes this test on purpose, in the same change that sets the address.
  it("offers no gated app live on mainnet", () => {
    for (const key of Object.values(NEEDS_CONTRACT)) expect(contractAddress(ARCOS.mainnet, key), key).toBeNull();
    expect(contractAddress(ARCOS.mainnet, "proPass")).toBeNull();
    for (const m of appsFor("mainnet")) if (m.id in NEEDS_CONTRACT) expect(m.comingSoon, m.id).toBe(true);
  });
});
