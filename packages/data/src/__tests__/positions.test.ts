import { describe, expect, it } from "vitest";
import { UNISWAP_V4 } from "@arcos/chain";
import { positionDoc, positionKey } from "../positions";

const POOL = `0x${"AB".repeat(32)}`;
const SENDER = "0xF0d631d54c7e1040CCFa1c2ed737973D6A652544";
const salt = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

describe("positionDoc", () => {
  it("stores the key lowercased with the block that first named it, and no liquidity", () => {
    expect(positionDoc("mainnet", POOL, { owner: SENDER, tickLower: -60, tickUpper: 120, salt: `0x${"0".repeat(62)}AB` }, 32_000_000)).toEqual({
      network: "mainnet",
      poolId: POOL.toLowerCase(),
      owner: SENDER.toLowerCase(),
      tickLower: -60,
      tickUpper: 120,
      salt: `0x${"0".repeat(62)}ab`,
      tokenId: null,
      firstBlock: 32_000_000,
    });
  });

  it("names the NFT when the PositionManager holds the position: its salt is the token id", () => {
    const doc = positionDoc("mainnet", POOL, { owner: UNISWAP_V4.positionManager, tickLower: -887_250, tickUpper: 887_250, salt: salt(332_087n) }, 1);
    expect(doc.tokenId).toBe("332087");
    // A token id past 2^53 keeps every digit.
    expect(positionDoc("mainnet", POOL, { owner: UNISWAP_V4.positionManager.toLowerCase(), tickLower: 0, tickUpper: 1, salt: salt(2n ** 200n + 1n) }, 1).tokenId).toBe((2n ** 200n + 1n).toString());
  });

  it("gives the same doc for the same log, whatever the case of its addresses", () => {
    const key = { owner: SENDER, tickLower: -60, tickUpper: 60, salt: salt(7n) };
    expect(positionDoc("mainnet", POOL, key, 5)).toEqual(positionDoc("mainnet", POOL.toLowerCase(), { ...key, owner: SENDER.toLowerCase() }, 5));
  });
});

describe("positionKey", () => {
  it("is the stored position as the Inspector reads it: the four key fields and nothing else", () => {
    const doc = positionDoc("mainnet", POOL, { owner: SENDER, tickLower: -60, tickUpper: 60, salt: salt(7n) }, 5);
    expect(positionKey(doc)).toEqual({ owner: SENDER.toLowerCase(), tickLower: -60, tickUpper: 60, salt: salt(7n) });
  });
});
