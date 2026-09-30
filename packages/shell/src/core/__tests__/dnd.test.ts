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

  it("rejects junk and bad fields", () => {
    expect(decodeDragItem("token", "not json")).toBeNull();
    expect(decodeDragItem("token", "null")).toBeNull();
    expect(decodeDragItem("token", JSON.stringify({ ...token, kind: "lock" }))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify({ ...token, address: "0x123" }))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify({ ...token, decimals: 1.5 }))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify({ ...token, decimals: 99 }))).toBeNull();
  });

  it("truncates an oversized symbol instead of trusting it", () => {
    const item = decodeDragItem("token", JSON.stringify({ ...token, symbol: "X".repeat(500) }));
    expect(item?.kind === "token" ? item.symbol : null).toHaveLength(32);
  });

  it("finds the accepted kind from a type list", () => {
    const types = ["text/plain", dndMime("token")];
    expect(acceptedKind(types, ["token"])).toBe("token");
    expect(acceptedKind([], ["token"])).toBeNull();
  });

  it("turns a token into window params", () => {
    expect(dropParams(token)).toEqual({ token: token.address });
  });
});

const approval: DragItem = {
  kind: "approval",
  approval: "erc20",
  token: "0x3600000000000000000000000000000000000000",
  spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

describe("approval drag items", () => {
  it("round-trips each kind of approval, with the NFT's id when it has one", () => {
    const { mime, data } = encodeDragItem(approval);
    expect(mime).toBe("application/x-arcos-approval+json");
    expect(decodeDragItem("approval", data)).toEqual(approval);
    for (const kind of ["operator", "permit2"] as const) {
      const item: DragItem = { ...approval, approval: kind };
      expect(decodeDragItem("approval", encodeDragItem(item).data)).toEqual(item);
    }
    const nft: DragItem = { ...approval, approval: "erc721", tokenId: "115792089237316195423570985008687907853269984665640564039457584007913129639935" };
    expect(decodeDragItem("approval", encodeDragItem(nft).data)).toEqual(nft);
  });

  it("keeps only the fields it knows", () => {
    const extra = JSON.stringify({ ...approval, amount: "999", tokenId: "7" });
    expect(decodeDragItem("approval", extra)).toEqual(approval);
  });

  it("rejects junk, bad fields, and a kind other than the one asked for", () => {
    expect(decodeDragItem("approval", "not json")).toBeNull();
    expect(decodeDragItem("approval", JSON.stringify(token))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify(approval))).toBeNull();
    expect(decodeDragItem("approval", JSON.stringify({ ...approval, token: "0x12" }))).toBeNull();
    expect(decodeDragItem("approval", JSON.stringify({ ...approval, spender: 7 }))).toBeNull();
    expect(decodeDragItem("approval", JSON.stringify({ ...approval, approval: "erc1337" }))).toBeNull();
    expect(decodeDragItem("approval", JSON.stringify({ ...approval, approval: "erc721" }))).toBeNull();
    for (const tokenId of ["-1", "1.5", "0x10", "", 7, "1".repeat(79)]) {
      expect(decodeDragItem("approval", JSON.stringify({ ...approval, approval: "erc721", tokenId }))).toBeNull();
    }
  });

  it("finds the approval kind from a type list, and names the token as a drop target's params", () => {
    expect(acceptedKind([dndMime("approval")], ["approval"])).toBe("approval");
    expect(acceptedKind([dndMime("approval")], ["token"])).toBeNull();
    expect(dropParams(approval)).toEqual({ token: approval.token });
  });
});
