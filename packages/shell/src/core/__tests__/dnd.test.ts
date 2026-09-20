import { describe, expect, it } from "vitest";
import { acceptedKind, decodeDragItem, dndMime, dropParams, encodeDragItem, type DragItem } from "../dnd";

const token: DragItem = {
  kind: "token",
  address: "0x3600000000000000000000000000000000000000",
  symbol: "USDC",
  decimals: 6,
};

describe("drag items", () => {
  it("round-trips a token", () => {
    const { mime, data } = encodeDragItem(token);
    expect(mime).toBe("application/x-arcos-token+json");
    expect(decodeDragItem("token", data)).toEqual(token);
  });

  it("rejects junk, wrong kinds and bad fields", () => {
    expect(decodeDragItem("token", "not json")).toBeNull();
    expect(decodeDragItem("token", "null")).toBeNull();
    expect(decodeDragItem("lock", JSON.stringify(token))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify({ ...token, address: "0x123" }))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify({ ...token, decimals: 1.5 }))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify({ ...token, decimals: 99 }))).toBeNull();
  });

  it("truncates an oversized symbol instead of trusting it", () => {
    const item = decodeDragItem("token", JSON.stringify({ ...token, symbol: "X".repeat(500) }));
    expect(item?.symbol).toHaveLength(32);
  });

  it("finds the accepted kind from a type list", () => {
    const types = ["text/plain", dndMime("token")];
    expect(acceptedKind(types, ["lock", "token"])).toBe("token");
    expect(acceptedKind(types, ["lock"])).toBeNull();
    expect(acceptedKind([], ["token"])).toBeNull();
  });

  it("turns a token into window params", () => {
    expect(dropParams(token)).toEqual({ token: token.address, symbol: "USDC", decimals: "6" });
  });
});
