import { describe, expect, it } from "vitest";
import { cleanLabel } from "@arcos/inspector";
import { LAUNCHPADS, launchpadOf } from "../launchpads";

const ZERO = "0x0000000000000000000000000000000000000000";
const PAD = "0x00000000000000000000000000000000000ab001";

describe("LAUNCHPADS", () => {
  it("keys every entry by a lowercase address that isn't the zero address", () => {
    for (const key of Object.keys(LAUNCHPADS)) {
      expect(key, key).toMatch(/^0x[0-9a-f]{40}$/);
      expect(key, key).not.toBe(ZERO);
    }
  });

  it("names every entry in 1 to 24 safe characters", () => {
    for (const [key, name] of Object.entries(LAUNCHPADS)) {
      expect(name.length, key).toBeGreaterThanOrEqual(1);
      expect(name.length, key).toBeLessThanOrEqual(24);
      expect(name, key).toBe(cleanLabel(name, 24));
    }
  });
});

describe("launchpadOf", () => {
  const map = { [PAD]: "Padlaunch" };

  it("finds a creator whatever the case of its letters", () => {
    expect(launchpadOf(PAD, map)).toBe("Padlaunch");
    expect(launchpadOf(PAD.toUpperCase().replace("0X", "0x"), map)).toBe("Padlaunch");
  });

  it("answers null for an unknown creator, no creator, junk, and an inherited property name", () => {
    expect(launchpadOf("0x00000000000000000000000000000000000ab002", map)).toBeNull();
    expect(launchpadOf(null, map)).toBeNull();
    expect(launchpadOf(undefined, map)).toBeNull();
    expect(launchpadOf("not an address", map)).toBeNull();
    expect(launchpadOf("__proto__", map)).toBeNull();
    expect(launchpadOf("constructor", map)).toBeNull();
    expect(launchpadOf(PAD)).toBeNull();
  });
});
