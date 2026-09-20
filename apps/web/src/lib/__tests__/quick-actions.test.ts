import { describe, expect, it } from "vitest";
import { quickActions } from "../quick-actions";

describe("quickActions", () => {
  it("offers an inspection for a pasted address", () => {
    const a = "0x3600000000000000000000000000000000000000";
    expect(quickActions(` ${a} `)).toEqual([
      { id: `inspect:${a}`, title: "Inspect 0x3600…0000", hint: "Token report", appId: "inspector", params: { token: a } },
    ]);
  });
  it("offers nothing otherwise", () => {
    expect(quickActions("mint")).toEqual([]);
    expect(quickActions("0x123")).toEqual([]);
  });
});
