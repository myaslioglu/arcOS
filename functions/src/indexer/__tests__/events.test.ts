import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { ARCOS, tokenFactoryAbi } from "@arcos/chain";
import { TOPICS, decodeLog, decodeLogs, sourcesFor, type RawLog } from "../events";
import real from "./fixtures/mainnet-logs.json";

// Real logs, as rpc.mainnet.arc.io answered eth_getLogs on 2026-10-02 (blockTimestamp included). TokenCreated has no
// mainnet log yet, so its fixture is encoded from the TokenFactory's exported ABI below.
const LOGS = real as Record<keyof typeof real, RawLog>;
const sources = sourcesFor("mainnet");

function tokenCreatedLog(): RawLog {
  const topics = encodeEventTopics({
    abi: tokenFactoryAbi,
    eventName: "TokenCreated",
    args: {
      creator: "0x463A81a017326E9029DcCA2a2d9AA42599Bef12c",
      token: "0x00000000000000000000000000000000000a6a01",
      holder: "0x463A81a017326E9029DcCA2a2d9AA42599Bef12c",
    },
  }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "bool" }],
    ["Test Token", "TEST", 18, 10n ** 24n, 0n, false, true],
  );
  return { address: ARCOS.mainnet!.tokenFactory.toLowerCase(), topics, data, blockNumber: "0x16b8200", logIndex: "0x1", blockTimestamp: "0x6abf4000" };
}

describe("sourcesFor", () => {
  it("names the five mainnet contracts, each with the one event read from it, under the 20-address cap", () => {
    expect(sources.map((s) => [s.kind, s.address.toLowerCase(), s.topic0])).toEqual([
      ["factory", "0xa68edd822048c00dc816d93005b72f8a50234a24", TOPICS.tokenCreated],
      ["v2", "0x89e5db8b5aa49aa85ac63f691524311aeb649eba", TOPICS.pairCreated],
      ["v3", "0xf0db7b58379503491d857db50ac9ece64c653918", TOPICS.v3PoolCreated],
      ["v4", "0x8366a39cc670b4001a1121b8f6a443a643e40951", TOPICS.initialize],
      ["aero", "0xb89df768af2cfe637ceb352c587fe8edaf491d03", TOPICS.aeroPoolCreated],
    ]);
  });

  it("has the topic0 every real log carries", () => {
    expect(LOGS.pairCreated.topics[0]).toBe(TOPICS.pairCreated);
    expect(LOGS.v3PoolCreated.topics[0]).toBe(TOPICS.v3PoolCreated);
    expect(LOGS.initialize.topics[0]).toBe(TOPICS.initialize);
    expect(LOGS.aeroPoolCreated.topics[0]).toBe(TOPICS.aeroPoolCreated);
    expect(TOPICS.tokenCreated).toBe("0xeff4850e1746efeb66df24d48b44f7db5d52c87815128cdcdece747329ef77e3");
  });

  it("has only the v4 PoolManager and the TokenFactory on testnet", () => {
    expect(sourcesFor("testnet").map((s) => s.kind)).toEqual(["factory", "v4"]);
  });
});

describe("decodeLog, on real mainnet logs", () => {
  it("reads a Uniswap v2 PairCreated: the pair, both tokens, the fixed 0.3% fee", () => {
    expect(decodeLog(LOGS.pairCreated, sources)).toEqual({
      kind: "pool", version: "v2", id: "0x8f8b1e646d512ea39f819268e1dcce3e06c5b308",
      currency0: "0x3600000000000000000000000000000000000000", currency1: "0xadb050501b4347aaea8becb1f02b738b7b592e05",
      fee: 3000, tickSpacing: null, hooks: null, block: 23_776_690, logIndex: 197, timestamp: 0x6abed7b0,
    });
  });

  it("reads a Uniswap v3 PoolCreated: the pool, the fee from topic 3 and the tick spacing from the data", () => {
    expect(decodeLog(LOGS.v3PoolCreated, sources)).toEqual({
      kind: "pool", version: "v3", id: "0x2982e0fed1815f130110b60c82339db9a4731677",
      currency0: "0x3600000000000000000000000000000000000000", currency1: "0xe90081996ebe916b350f4579d96fc6b3b74c0087",
      fee: 10_000, tickSpacing: 200, hooks: null, block: 23_822_589, logIndex: 2, timestamp: 0x6abf32aa,
    });
  });

  it("reads a Uniswap v4 Initialize: the pool id, the key and its hook", () => {
    expect(decodeLog(LOGS.initialize, sources)).toEqual({
      kind: "pool", version: "v4", id: "0x9e69bc27f0e8a343e84d204e4ff29d70d4ac3a9aaf8534f5b09bc29c6b3268cc",
      currency0: "0x3600000000000000000000000000000000000000", currency1: "0x470f09ae20163d5e243f6530fb328912a8fcb099",
      fee: 10_000, tickSpacing: 200, hooks: "0x83139c02ee291298baef473a775c2e996c066044",
      block: 23_822_520, logIndex: 18, timestamp: 0x6abf3287,
    });
  });

  it("reads a v4 pool against native USDC: currency0 is the zero address", () => {
    expect(decodeLog(LOGS.initializeNative, sources)).toMatchObject({
      version: "v4", currency0: "0x0000000000000000000000000000000000000000", currency1: "0xfb30538f17ba9b1fa9cc06e6e09b91502a36b777",
    });
  });

  it("reads an Aerodrome Slipstream PoolCreated: the tick spacing from topic 3, and no fee", () => {
    expect(decodeLog(LOGS.aeroPoolCreated, sources)).toEqual({
      kind: "pool", version: "aero", id: "0x8677b2de3393fe9c3e4761a20c00908ea1701ad5",
      currency0: "0x09d9a27d69fa7ed1a53b7377ec97c255536d3516", currency1: "0x3600000000000000000000000000000000000000",
      fee: null, tickSpacing: 2000, hooks: null, block: 22_218_624, logIndex: 8, timestamp: 0x6ab2c5ad,
    });
  });

  it("reads a TokenFactory TokenCreated: the token, its creator and what it was created with", () => {
    expect(decodeLog(tokenCreatedLog(), sources)).toEqual({
      kind: "token", token: "0x00000000000000000000000000000000000a6a01", creator: "0x463a81a017326e9029dcca2a2d9aa42599bef12c",
      name: "Test Token", symbol: "TEST", decimals: 18, initialSupply: 10n ** 24n, block: 0x16b8200, logIndex: 1, timestamp: 0x6abf4000,
    });
  });
});

describe("decodeLog, by emitter and topic0 together", () => {
  it("ignores a known event from an address the indexer doesn't read it from", () => {
    // A v3-shaped PoolCreated from the Aerodrome factory, and an Initialize from the v3 factory: both are someone else's.
    expect(decodeLog({ ...LOGS.v3PoolCreated, address: LOGS.aeroPoolCreated.address }, sources)).toBeNull();
    expect(decodeLog({ ...LOGS.initialize, address: LOGS.v3PoolCreated.address }, sources)).toBeNull();
    expect(decodeLog({ ...LOGS.initialize, address: "0x0000000000000000000000000000000000000bad" }, sources)).toBeNull();
  });

  it("ignores a removed log and one that doesn't decode", () => {
    expect(decodeLog({ ...LOGS.initialize, removed: true }, sources)).toBeNull();
    expect(decodeLog({ ...LOGS.initialize, data: "0x1234" }, sources)).toBeNull();
    expect(decodeLog({ ...LOGS.v3PoolCreated, topics: LOGS.v3PoolCreated.topics.slice(0, 2) }, sources)).toBeNull();
  });

  it("matches the emitter whatever its case, and leaves the timestamp null when the node sends none", () => {
    const bare: RawLog = { ...LOGS.pairCreated };
    delete bare.blockTimestamp;
    expect(decodeLog({ ...bare, address: bare.address.toUpperCase().replace("0X", "0x") }, sources)).toMatchObject({ version: "v2", timestamp: null });
  });
});

describe("decodeLogs", () => {
  it("returns chain order, block then log index, and drops what it can't read", () => {
    const later = { ...LOGS.initialize, blockNumber: LOGS.v3PoolCreated.blockNumber, logIndex: "0x9" as Hex };
    const sightings = decodeLogs([LOGS.v3PoolCreated, later, { ...LOGS.pairCreated, removed: true }, LOGS.initializeNative, LOGS.aeroPoolCreated], sources);
    expect(sightings.map((s) => [s.block, s.logIndex])).toEqual([
      [22_218_624, 8],
      [23_822_589, 2],
      [23_822_589, 9],
      [23_822_649, Number(BigInt(LOGS.initializeNative.logIndex))],
    ]);
  });
});
