import { describe, expect, it } from "vitest";
import { formatAppHash, parseAppHash } from "../deeplink";

describe("deep links", () => {
  it("formats an app with no params", () => {
    expect(formatAppHash("mint")).toBe("#app:mint");
  });

  it("formats and parses params, sorted and encoded", () => {
    const hash = formatAppHash("inspector", { token: "0xAbC", note: "a b&c" });
    expect(hash).toBe("#app:inspector?note=a+b%26c&token=0xAbC");
    expect(parseAppHash(hash)).toEqual({ appId: "inspector", params: { note: "a b&c", token: "0xAbC" } });
  });

  it("ignores anything that isn't an app hash", () => {
    expect(parseAppHash("")).toBeNull();
    expect(parseAppHash("#work")).toBeNull();
    expect(parseAppHash("#app:")).toBeNull();
    expect(parseAppHash("#app:Bad Id")).toBeNull();
  });
});
