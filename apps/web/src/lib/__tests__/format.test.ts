import { describe, expect, it } from "vitest";
import { shortAddress } from "../format";

describe("shortAddress", () => {
  it("keeps the first 6 and last 4 characters", () => {
    expect(shortAddress("0x3600000000000000000000000000000000000000")).toBe("0x3600…0000");
  });
  it("returns short input unchanged", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
});
