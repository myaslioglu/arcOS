import { describe, expect, it } from "vitest";
import { extractSelectors, minimalProxyTarget, usesOpcode, walkOpcodes } from "../bytecode";

describe("walkOpcodes", () => {
  it("skips push data", () => {
    // PUSH2 0x4444, STOP — the 0x44 bytes are data, not PREVRANDAO
    const ops = [...walkOpcodes("0x61444400")];
    expect(ops).toEqual([
      { pc: 0, op: 0x61, data: "4444" },
      { pc: 3, op: 0x00, data: "" },
    ]);
  });

  it("survives a truncated trailing push", () => {
    expect([...walkOpcodes("0x63aabb")]).toEqual([{ pc: 0, op: 0x63, data: "aabb" }]);
  });
});

describe("usesOpcode", () => {
  it("sees a real PREVRANDAO and ignores one inside push data", () => {
    expect(usesOpcode("0x4400", 0x44)).toBe(true);
    expect(usesOpcode("0x61444400", 0x44)).toBe(false);
  });

  it("ignores the CBOR metadata tail", () => {
    // code: STOP · metadata: a1 64 't' 'e' 's' 0x44 (6 bytes) · length 0x0006
    expect(usesOpcode("0x00" + "a16474657344" + "0006", 0x44)).toBe(false);
  });
});

describe("extractSelectors", () => {
  it("collects PUSH4 values and left-pads PUSH3", () => {
    const s = extractSelectors("0x6340c10f19" + "62aabbcc" + "00");
    expect([...s].sort()).toEqual(["0x00aabbcc", "0x40c10f19"]);
  });
});

describe("minimalProxyTarget", () => {
  const impl = "bebebebebebebebebebebebebebebebebebebebe";
  it("reads the implementation out of an EIP-1167 clone", () => {
    expect(minimalProxyTarget(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`)).toBe(`0x${impl}`);
  });
  it("returns null for anything else", () => {
    expect(minimalProxyTarget("0x6080604052")).toBeNull();
  });
});
