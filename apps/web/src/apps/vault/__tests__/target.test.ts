import { describe, expect, it } from "vitest";
import { targetFromDrop, targetFromParams } from "../target";

const TOKEN = "0xbff22091be481b41c8ca49862653aba216bac041";
const MANAGER = "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B";
const VAULT = "0x011916e14B8399feC0109f3402d283C71250C33C";

describe("targetFromParams", () => {
  it("reads a vault first, then a position, then a token, each checksummed", () => {
    expect(targetFromParams({ vault: VAULT, token: TOKEN })).toEqual({ kind: "vault", vault: VAULT });
    expect(targetFromParams({ manager: MANAGER, tokenId: "328647", token: TOKEN })).toEqual({ kind: "position", manager: MANAGER, tokenId: "328647" });
    expect(targetFromParams({ token: TOKEN })).toEqual({ kind: "token", token: "0xBFF22091be481B41C8CA49862653aBA216bAc041" });
  });

  it("ignores no params and junk", () => {
    expect(targetFromParams({})).toBeNull();
    expect(targetFromParams({ token: "0x12" })).toBeNull();
    expect(targetFromParams({ vault: "nope" })).toBeNull();
    expect(targetFromParams({ manager: MANAGER })).toBeNull();
    expect(targetFromParams({ manager: MANAGER, tokenId: "-1" })).toBeNull();
    expect(targetFromParams({ manager: MANAGER, tokenId: "1".repeat(79) })).toBeNull();
    expect(targetFromParams({ manager: "0x6049", tokenId: "1" })).toBeNull();
  });
});

describe("targetFromDrop", () => {
  it("takes a token, a position and a lock, and no approval", () => {
    expect(targetFromDrop({ kind: "token", address: TOKEN, symbol: "VTB", decimals: 18 })).toEqual({ kind: "token", token: "0xBFF22091be481B41C8CA49862653aBA216bAc041" });
    expect(targetFromDrop({ kind: "lp-position", manager: MANAGER, tokenId: "0" })).toEqual({ kind: "position", manager: MANAGER, tokenId: "0" });
    expect(targetFromDrop({ kind: "lock", address: VAULT })).toEqual({ kind: "vault", vault: VAULT });
    expect(targetFromDrop({ kind: "approval", approval: "erc20", token: TOKEN, spender: VAULT })).toBeNull();
  });
});
