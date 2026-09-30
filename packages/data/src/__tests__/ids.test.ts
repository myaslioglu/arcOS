import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deliveryId,
  normalizeAddress,
  normalizePoolId,
  poolId,
  radarFeedFilter,
  radarFeedId,
  tokenId,
  userId,
  watchId,
} from "../ids";
import { RADAR_FEED_FILTERS } from "../names";
import { refusal } from "./helpers/refusal";

const ADDR_MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";
const USDC = "0x3600000000000000000000000000000000000000";
const POOL32 = `0x${"ab".repeat(32)}`;

describe("normalizeAddress", () => {
  it("lowercases a checksummed address and leaves a lowercase one alone", () => {
    expect(normalizeAddress(ADDR_MIXED)).toBe(ADDR);
    expect(normalizeAddress(ADDR)).toBe(ADDR);
    expect(normalizeAddress(normalizeAddress(ADDR_MIXED))).toBe(ADDR);
  });

  it("refuses anything that is not 0x and 40 hex digits", () => {
    const bad = [
      "",
      "0x",
      `0x${"a".repeat(39)}`,
      `0x${"a".repeat(41)}`,
      ADDR.slice(2),
      `0X${"a".repeat(40)}`,
      `0x${"g".repeat(40)}`,
      ` ${ADDR}`,
      `${ADDR} `,
      `${ADDR}\n`,
    ];
    for (const value of bad) expect(refusal(() => normalizeAddress(value)).code, JSON.stringify(value)).toBe("address");
    for (const value of [undefined, null, 123, {}]) {
      expect(refusal(() => normalizeAddress(value as never)).code).toBe("address");
    }
  });

  it("never repeats what it refused: the input may be somebody's address", () => {
    const { message } = refusal(() => normalizeAddress(`0x${"c0ffee".repeat(6)}zz`));
    expect(message).not.toContain("c0ffee");
  });
});

describe("tokenId", () => {
  it("is <network>:<lowercase address>", () => {
    expect(tokenId("mainnet", ADDR_MIXED)).toBe(`mainnet:${ADDR}`);
    expect(tokenId("testnet", USDC)).toBe(`testnet:${USDC}`);
  });

  it("refuses an unknown network and a bad address", () => {
    for (const network of ["Mainnet", "", "default", "mainnet:"]) {
      expect(refusal(() => tokenId(network as never, ADDR)).code, network).toBe("network");
    }
    expect(refusal(() => tokenId("mainnet", "0x1234")).code).toBe("address");
  });
});

describe("poolId", () => {
  it("lowercases a pair or pool address", () => {
    expect(poolId("mainnet", ADDR_MIXED)).toBe(`mainnet:${ADDR}`);
  });

  it("passes a v4 pool id through, in lowercase, since it is 32 bytes of hex and not an address", () => {
    expect(poolId("mainnet", POOL32)).toBe(`mainnet:${POOL32}`);
    expect(poolId("testnet", `0x${"AB".repeat(32)}`)).toBe(`testnet:${POOL32}`);
    expect(normalizePoolId(POOL32)).toBe(POOL32);
    expect(normalizePoolId(ADDR_MIXED)).toBe(ADDR);
  });

  it("refuses anything that is neither an address nor a 32-byte id", () => {
    const bad = ["", "0x", `0x${"a".repeat(63)}`, `0x${"a".repeat(65)}`, `0x${"a".repeat(41)}`, `0x${"z".repeat(64)}`, ` ${POOL32}`];
    for (const value of bad) expect(refusal(() => poolId("mainnet", value)).code, value).toBe("pool-id");
    expect(refusal(() => poolId("nowhere" as never, ADDR)).code).toBe("network");
  });
});

describe("userId", () => {
  it("is the lowercase address", () => {
    expect(userId(ADDR_MIXED)).toBe(ADDR);
    expect(refusal(() => userId("nope")).code).toBe("address");
  });
});

describe("watchId", () => {
  it("is <user>:<network>:<token>, all lowercase: the id is the unique constraint", () => {
    expect(watchId(ADDR_MIXED, "mainnet", USDC)).toBe(`${ADDR}:mainnet:${USDC}`);
    expect(watchId(ADDR, "testnet", ADDR_MIXED)).toBe(`${ADDR}:testnet:${ADDR}`);
  });

  it("validates all three parts", () => {
    expect(refusal(() => watchId("x", "mainnet", USDC)).code).toBe("address");
    expect(refusal(() => watchId(ADDR, "other" as never, USDC)).code).toBe("network");
    expect(refusal(() => watchId(ADDR, "mainnet", "x")).code).toBe("address");
  });
});

describe("deliveryId", () => {
  it("is <alert id>:<lowercase address>:telegram", () => {
    expect(deliveryId("Kq3xN0w2BvR7tYpLm9Zc", ADDR_MIXED)).toBe(`Kq3xN0w2BvR7tYpLm9Zc:${ADDR}:telegram`);
    expect(deliveryId("a-b_c", ADDR)).toBe(`a-b_c:${ADDR}:telegram`);
  });

  it("refuses an alert id that could break the id apart or leave the collection", () => {
    for (const alertId of ["", "a:b", "a/b", ".", "..", "a b", "x".repeat(129)]) {
      expect(refusal(() => deliveryId(alertId, ADDR)).code, alertId).toBe("alert-id");
    }
    expect(refusal(() => deliveryId("abc", "nope")).code).toBe("address");
  });
});

describe("radarFeedId", () => {
  it("is <network>:<filter> for the four feeds", () => {
    for (const filter of RADAR_FEED_FILTERS) expect(radarFeedId("mainnet", filter)).toBe(`mainnet:${filter}`);
    expect(radarFeedId("testnet", "liquid-passing")).toBe("testnet:liquid-passing");
  });

  it("refuses another feed and another network", () => {
    for (const filter of ["everything", "liquid,passing", ""]) {
      expect(refusal(() => radarFeedId("mainnet", filter as never)).code, filter).toBe("radar-filter");
    }
    expect(refusal(() => radarFeedId("x" as never, "all")).code).toBe("network");
  });
});

describe("radarFeedFilter", () => {
  it("names the feed for the two stored flags", () => {
    expect(radarFeedFilter({ liquid: false, passing: false })).toBe("all");
    expect(radarFeedFilter({ liquid: true, passing: false })).toBe("liquid");
    expect(radarFeedFilter({ liquid: false, passing: true })).toBe("passing");
    expect(radarFeedFilter({ liquid: true, passing: true })).toBe("liquid-passing");
  });
});

describe("ids, for any valid input", () => {
  const hexDigits = fc.constantFrom(..."0123456789abcdefABCDEF".split(""));
  const hex = (length: number) => fc.array(hexDigits, { minLength: length, maxLength: length }).map((digits) => digits.join(""));
  const address = hex(40).map((digits) => `0x${digits}`);
  const anyPoolId = fc.oneof(address, hex(64).map((digits) => `0x${digits}`));
  const network = fc.constantFrom("mainnet" as const, "testnet" as const);

  // Firestore refuses a doc id with a slash, "." or "..", one shaped __like this__, or over 1,500 bytes.
  const legalDocId = (id: string) =>
    !id.includes("/") && id !== "." && id !== ".." && !/^__.*__$/.test(id) && Buffer.byteLength(id) <= 1500;

  it("are legal Firestore document ids", () => {
    fc.assert(
      fc.property(network, address, anyPoolId, (n, a, p) =>
        [tokenId(n, a), poolId(n, p), watchId(a, n, a), userId(a), deliveryId("abc", a), radarFeedId(n, "all")].every(legalDocId),
      ),
    );
  });

  it("do not depend on the case of an address", () => {
    fc.assert(fc.property(network, address, (n, a) => tokenId(n, a) === tokenId(n, `0x${a.slice(2).toUpperCase()}`)));
  });

  it("tell two addresses apart exactly when they differ beyond case", () => {
    fc.assert(
      fc.property(network, address, address, (n, a, b) => (tokenId(n, a) === tokenId(n, b)) === (a.toLowerCase() === b.toLowerCase())),
    );
  });

  it("tell the two networks apart", () => {
    fc.assert(fc.property(address, (a) => tokenId("mainnet", a) !== tokenId("testnet", a)));
  });
});
