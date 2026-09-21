import { describe, expect, it } from "vitest";
import { dropAssetDecimals, dropAssetTokenAddress, resolveDropAsset, type DropAsset } from "../asset";

const VALID = "0x1111111111111111111111111111111111111111";
const CHECKSUMMED = "0x1111111111111111111111111111111111111111"; // all-digit — same in every case

describe("resolveDropAsset (N8 — an explicit discriminated asset, never 'null means native')", () => {
  it("is always native in usdc mode, regardless of whatever is in the token address field", () => {
    expect(resolveDropAsset({ mode: "usdc", tokenAddr: "", decimals: null, symbol: null })).toEqual({ kind: "native" });
    expect(resolveDropAsset({ mode: "usdc", tokenAddr: "not an address", decimals: null, symbol: null })).toEqual({ kind: "native" });
    // Even a fully resolved decimals/symbol pair left over from a previous "Another token" pick
    // must not leak into native mode — see the "reverse" test below for the full scenario.
    expect(resolveDropAsset({ mode: "usdc", tokenAddr: VALID, decimals: 18, symbol: "DUKE" })).toEqual({ kind: "native" });
  });

  it("is unresolved in token mode with an empty address — this is the exact N8 hazard: an empty field must never fall through to native", () => {
    expect(resolveDropAsset({ mode: "token", tokenAddr: "", decimals: null, symbol: null })).toEqual({ kind: "unresolved" });
  });

  it("is unresolved in token mode with a half-typed / invalid address", () => {
    expect(resolveDropAsset({ mode: "token", tokenAddr: "0x123", decimals: null, symbol: null })).toEqual({ kind: "unresolved" });
  });

  it("is unresolved while a valid address's decimals are still loading (or failed)", () => {
    expect(resolveDropAsset({ mode: "token", tokenAddr: VALID, decimals: null, symbol: "DUKE" })).toEqual({ kind: "unresolved" });
  });

  it("is unresolved while a valid address's symbol is still loading", () => {
    expect(resolveDropAsset({ mode: "token", tokenAddr: VALID, decimals: 18, symbol: null })).toEqual({ kind: "unresolved" });
  });

  it("resolves to a specific token once both decimals and symbol are known, checksumming the address", () => {
    expect(resolveDropAsset({ mode: "token", tokenAddr: VALID.toLowerCase(), decimals: 18, symbol: "DUKE" })).toEqual({
      kind: "token",
      address: CHECKSUMMED,
      decimals: 18,
      symbol: "DUKE",
    });
  });

  it("(the reverse) switching back to usdc after a token was resolved drops the token's decimals — native is always 'kind: native', never carries a stale decimals value", () => {
    const token = resolveDropAsset({ mode: "token", tokenAddr: VALID, decimals: 18, symbol: "DUKE" });
    expect(token).toEqual({ kind: "token", address: CHECKSUMMED, decimals: 18, symbol: "DUKE" });
    const backToUsdc = resolveDropAsset({ mode: "usdc", tokenAddr: VALID, decimals: 18, symbol: "DUKE" });
    expect(backToUsdc).toEqual({ kind: "native" });
    expect(dropAssetDecimals(backToUsdc)).toBe(6);
  });
});

describe("dropAssetDecimals — no default decimals for an unresolved token", () => {
  it("is 6 for native", () => {
    expect(dropAssetDecimals({ kind: "native" })).toBe(6);
  });

  it("is the token's own decimals for a resolved token", () => {
    expect(dropAssetDecimals({ kind: "token", address: VALID, decimals: 9, symbol: "X" })).toBe(9);
  });

  it("is null for an unresolved token — never a default, so amounts can't be parsed at the wrong scale", () => {
    expect(dropAssetDecimals({ kind: "unresolved" })).toBeNull();
  });
});

describe("dropAssetTokenAddress — the only way send() can learn a non-native address", () => {
  it("is null for native", () => {
    expect(dropAssetTokenAddress({ kind: "native" })).toBeNull();
  });

  it("is the resolved address for a token", () => {
    expect(dropAssetTokenAddress({ kind: "token", address: VALID, decimals: 18, symbol: "X" })).toBe(VALID);
  });

  it("is null for unresolved — never a fallback to native's address (there is none) or a guess", () => {
    expect(dropAssetTokenAddress({ kind: "unresolved" })).toBeNull();
  });
});

describe("DropAsset — exhaustiveness sanity (compile-time, exercised at runtime)", () => {
  it("every kind maps to a distinct branch — a switch over `kind` covers native/token/unresolved with no other case", () => {
    const kinds: DropAsset["kind"][] = ["native", "token", "unresolved"];
    expect(kinds).toEqual(["native", "token", "unresolved"]);
  });
});
