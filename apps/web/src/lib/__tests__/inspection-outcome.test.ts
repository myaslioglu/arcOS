import { describe, expect, it } from "vitest";
import { NotAContract } from "@arcos/inspector";
import { InspectionTimeout } from "../deadline";
import { isBusy, isNotAContract } from "../inspection-outcome";

/** The same error, as another bundled copy of its module would throw it: a different class with the same name. */
const fromAnotherCopy = (name: string) => {
  const e = new Error("from another copy");
  e.name = name;
  return e;
};

describe("how an inspection ended without a report", () => {
  it("recognises no contract at the address, from this copy of the engine or another", () => {
    expect(isNotAContract(new NotAContract("0x1111111111111111111111111111111111111111"))).toBe(true);
    expect(isNotAContract(fromAnotherCopy("NotAContract"))).toBe(true);
  });

  it("recognises backpressure (a full gate, a deadline), from any copy of inspect-server", () => {
    expect(isBusy(new InspectionTimeout())).toBe(true);
    expect(isBusy(fromAnotherCopy("InspectorBusy"))).toBe(true);
    expect(isBusy(fromAnotherCopy("InspectionTimeout"))).toBe(true);
  });

  it("takes nothing else for either", () => {
    for (const e of [new Error("ECONNRESET"), fromAnotherCopy("TypeError"), "InspectorBusy", null]) {
      expect([isBusy(e), isNotAContract(e)]).toEqual([false, false]);
    }
  });
});
