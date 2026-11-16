import { describe, expect, it } from "vitest";
import { acceptedKind, decodeDragItem, dndMime, dragText, dropParams, encodeDragItem, type DragItem } from "../dnd";

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

const position: DragItem = { kind: "lp-position", manager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B", tokenId: "328647" };
const lock: DragItem = { kind: "lock", address: "0x2aA12f98795E7A65072950AfbA9d1E023D398241" };

describe("position drag items", () => {
  it("round-trips a position, with the largest id a uint256 holds", () => {
    const { mime, data } = encodeDragItem(position);
    expect(mime).toBe("application/x-arcos-lp-position+json");
    expect(decodeDragItem("lp-position", data)).toEqual(position);
    const huge: DragItem = { ...position, tokenId: (2n ** 256n - 1n).toString() };
    expect(decodeDragItem("lp-position", encodeDragItem(huge).data)).toEqual(huge);
    expect(decodeDragItem("lp-position", JSON.stringify({ ...position, tokenId: "0" }))).toEqual({ ...position, tokenId: "0" });
  });

  it("keeps only the manager and the id", () => {
    const extra = JSON.stringify({ ...position, symbol: "FAKE", liquidity: "1", unlockAt: 1 });
    expect(decodeDragItem("lp-position", extra)).toEqual(position);
  });

  it("rejects a bad manager, a bad id, and a kind other than the one asked for", () => {
    expect(decodeDragItem("lp-position", "not json")).toBeNull();
    expect(decodeDragItem("lp-position", JSON.stringify(token))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify(position))).toBeNull();
    expect(decodeDragItem("lp-position", JSON.stringify({ ...position, manager: "0x6049" }))).toBeNull();
    expect(decodeDragItem("lp-position", JSON.stringify({ ...position, manager: 7 }))).toBeNull();
    for (const tokenId of ["-1", "1.5", "0x10", "", "01", 7, null, (2n ** 256n).toString(), "1".repeat(79)]) {
      expect(decodeDragItem("lp-position", JSON.stringify({ ...position, tokenId })), String(tokenId)).toBeNull();
    }
  });

  it("opens a window with the manager and the id, and reads as <manager>#<id> outside the desktop", () => {
    expect(dropParams(position)).toEqual({ manager: position.manager, tokenId: "328647" });
    expect(dragText(position)).toBe("0x6049c9a0e26405C0985f9E3685C87d0aE917f82B#328647");
    expect(acceptedKind([dndMime("lp-position")], ["token", "lp-position", "lock"])).toBe("lp-position");
  });
});

describe("lock drag items", () => {
  it("round-trips a lock and keeps only its address", () => {
    const { mime, data } = encodeDragItem(lock);
    expect(mime).toBe("application/x-arcos-lock+json");
    expect(decodeDragItem("lock", data)).toEqual(lock);
    expect(decodeDragItem("lock", JSON.stringify({ ...lock, amount: "999", owner: lock.address }))).toEqual(lock);
  });

  it("rejects junk, a bad address, and a kind other than the one asked for", () => {
    expect(decodeDragItem("lock", "null")).toBeNull();
    expect(decodeDragItem("lock", JSON.stringify({ kind: "lock" }))).toBeNull();
    expect(decodeDragItem("lock", JSON.stringify({ ...lock, address: "0x2aA1" }))).toBeNull();
    expect(decodeDragItem("lock", JSON.stringify({ ...lock, address: ["0x2aA12f98795E7A65072950AfbA9d1E023D398241"] }))).toBeNull();
    expect(decodeDragItem("lock", JSON.stringify(token))).toBeNull();
    expect(decodeDragItem("token", JSON.stringify(lock))).toBeNull();
  });

  it("opens a window with the vault, and reads as the vault's address outside the desktop", () => {
    expect(dropParams(lock)).toEqual({ vault: lock.address });
    expect(dragText(lock)).toBe(lock.address);
    expect(acceptedKind([dndMime("lock")], ["token"])).toBeNull();
  });
});
