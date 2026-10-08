import { describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  DATABASE_ENV,
  DATABASE_ID,
  DELIVERY_MAX_AGE_MS,
  DELIVERY_MAX_ATTEMPTS,
  FREE_WATCH_LIMIT,
  LIQUIDITY_DROP,
  NETWORKS,
  RADAR_FEED_FILTERS,
  TTL_COLLECTIONS,
  TTL_FIELD,
  TTL_MS,
  isNetwork,
} from "../names";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("the database", () => {
  it("is the named database arcos, and the test override has a fixed name", () => {
    expect(DATABASE_ID).toBe("arcos");
    expect(DATABASE_ENV).toBe("ARCOS_FIRESTORE_DATABASE");
  });
});

describe("networks", () => {
  it("are the two of @arcos/chain", () => {
    expect(NETWORKS).toEqual(["mainnet", "testnet"]);
  });

  it("are recognised exactly", () => {
    expect(isNetwork("mainnet")).toBe(true);
    expect(isNetwork("testnet")).toBe(true);
    for (const value of ["", "Mainnet", "main", "toString", "__proto__", null, undefined, 1]) {
      expect(isNetwork(value), String(value)).toBe(false);
    }
  });
});

describe("collections", () => {
  it("are the twelve of design 1.6, each under its own name", () => {
    expect(COLLECTIONS).toEqual({
      indexer: "indexer",
      tokens: "tokens",
      pools: "pools",
      reports: "reports",
      users: "users",
      watches: "watches",
      watchState: "watchState",
      alerts: "alerts",
      deliveries: "deliveries",
      nonces: "nonces",
      linkCodes: "linkCodes",
      radarFeed: "radarFeed",
    });
  });
});

describe("TTL", () => {
  it("sits on expiresAt", () => {
    expect(TTL_FIELD).toBe("expiresAt");
  });

  it("covers nonces, linkCodes, alerts, deliveries and reports, with the lifetimes of design 1.6", () => {
    expect(TTL_MS).toEqual({
      nonces: 10 * MINUTE,
      linkCodes: 10 * MINUTE,
      alerts: 90 * DAY,
      deliveries: 30 * DAY,
      reports: 90 * DAY,
    });
    expect([...TTL_COLLECTIONS].sort()).toEqual(["alerts", "deliveries", "linkCodes", "nonces", "reports"]);
  });

  it("only names collections that exist", () => {
    for (const name of TTL_COLLECTIONS) expect(COLLECTIONS[name]).toBe(name);
  });
});

describe("radar feeds", () => {
  it("come in four filters", () => {
    expect(RADAR_FEED_FILTERS).toEqual(["all", "liquid", "passing", "liquid-passing"]);
  });
});

describe("Watchdog's numbers", () => {
  it("lets a wallet watch three tokens", () => {
    expect(FREE_WATCH_LIMIT).toBe(3);
  });

  it("tries a delivery four times in all, and gives up on one a day old", () => {
    expect(DELIVERY_MAX_ATTEMPTS).toBe(4);
    expect(DELIVERY_MAX_AGE_MS).toBe(DAY);
  });

  it("calls a liquidity drop an alert at 30% and 500 quote units, both as bigints", () => {
    expect(LIQUIDITY_DROP).toEqual({ bps: 3000n, minUnits: 500_000_000n });
  });
});
