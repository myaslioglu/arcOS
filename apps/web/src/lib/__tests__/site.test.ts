import { describe, expect, it } from "vitest";
import { networkBadge, robotsHeaders, siteRobots, siteTitle } from "../site";

// The testnet site (https://testnet.4rcos.com) says what it is, and asks search engines to leave it out. The mainnet
// site keeps what it had: its title, no badge, and no robots rule of its own (Next's default, indexable).
describe("the site per network", () => {
  it("labels the testnet site, and not the mainnet one", () => {
    expect(networkBadge("testnet")).toBe("Testnet");
    expect(networkBadge("mainnet")).toBeUndefined();
    expect(siteTitle("testnet")).toBe("4rc.OS Testnet");
    expect(siteTitle("mainnet")).toBe("4rc.OS");
  });

  it("asks search engines not to index or follow the testnet site, in its pages and in every answer's headers", () => {
    expect(siteRobots("testnet")).toEqual({ index: false, follow: false });
    expect(robotsHeaders("testnet")).toEqual([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]);
  });

  it("adds nothing on mainnet", () => {
    expect(siteRobots("mainnet")).toBeUndefined();
    expect(robotsHeaders("mainnet")).toEqual([]);
  });
});
