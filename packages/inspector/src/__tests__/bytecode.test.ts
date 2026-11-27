import { describe, expect, it } from "vitest";
import { extractSelectors, minimalProxyTarget, opaqueCode, usesOpcode, walkOpcodes } from "../bytecode";

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

describe("opaqueCode", () => {
  const delegate = "ab".repeat(20);
  it("reads EIP-7702's delegation designator, exactly 0xef0100 and an address", () => {
    expect(opaqueCode(`0xef0100${delegate}`)).toBe("eip7702");
    expect(opaqueCode(`0xEF0100${delegate.toUpperCase()}`)).toBe("eip7702");
    // A byte more or less is no designator.
    expect(opaqueCode(`0xef0100${delegate}00`)).toBeNull();
    expect(opaqueCode(`0xef0100${delegate.slice(2)}`)).toBeNull();
  });
  it("reads an Arbitrum Stylus program by its prefix", () => {
    expect(opaqueCode("0xeff00000aabbccdd")).toBe("stylus");
    expect(opaqueCode("0xEFF000")).toBe("stylus");
  });
  it("leaves EVM bytecode, a clone included, to the scans", () => {
    expect(opaqueCode("0x6080604052")).toBeNull();
    expect(opaqueCode(`0x363d3d373d3d3d363d73${delegate}5af43d82803e903d91602b57fd5bf3`)).toBeNull();
    expect(opaqueCode("0xef")).toBeNull();
  });
});
