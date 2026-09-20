import { describe, expect, it } from "vitest";
import { resolveRoute } from "../route";

describe("resolveRoute", () => {
  it("toArc: the picked chain is the source, Arc is the destination", () => {
    expect(resolveRoute("toArc", "Ethereum_Sepolia", "Arc_Testnet")).toEqual({ source: "Ethereum_Sepolia", dest: "Arc_Testnet" });
  });

  it("fromArc: Arc is the source, the picked chain is the destination", () => {
    expect(resolveRoute("fromArc", "Ethereum_Sepolia", "Arc_Testnet")).toEqual({ source: "Arc_Testnet", dest: "Ethereum_Sepolia" });
  });
});
