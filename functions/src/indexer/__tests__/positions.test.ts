import { describe, expect, it } from "vitest";
import { DEX, UNISWAP_V4, UNISWAP_V4_FROM } from "@arcos/chain";
import { INDEXED_POSITIONS_LIMIT, INDEXED_POSITIONS_TOTAL } from "@arcos/data";
import { MAX_POSITIONS, MAX_POSITIONS_PER_POOL, TAIL_MAX_BLOCKS } from "@arcos/inspector";
import { ZERO, addr, modifyLiquidity, v3Pool, v4Pool } from "../../__emulator__/fakes";
import { POSITIONS_LIMITS } from "../positions-run";
import { decodePoolLogs, decodePositionLogs } from "../positions-store";
import { LIMITS } from "../run";
import { INDEXER_OPTIONS } from "../schedule";
import { STATS_LIMITS } from "../stats-run";
import { MAX_WINDOW } from "../windows";

const PM = UNISWAP_V4.poolManager;
const POOL = `0x${"a1".repeat(32)}` as const;
const OTHER = `0x${"b2".repeat(32)}` as const;
const NFTS = UNISWAP_V4.positionManager;
const window = { from: 1_000, to: 1_999 };
const salt = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

describe("decodePositionLogs", () => {
  it("reads each ModifyLiquidity as a position: the pool, the sender, the range and the salt, lowercased", () => {
    expect(decodePositionLogs([modifyLiquidity(1_500, POOL, NFTS, 332_087n, 10n ** 18n, -887_250, 887_250)], PM, window)).toEqual([
      { poolId: POOL, key: { owner: NFTS.toLowerCase(), tickLower: -887_250, tickUpper: 887_250, salt: salt(332_087n) }, block: 1_500 },
    ]);
  });

  it("lists a position once however often its liquidity changed, with the first block that named it", () => {
    const logs = [
      modifyLiquidity(1_700, POOL, NFTS, 7n, -(10n ** 18n)),
      modifyLiquidity(1_200, POOL, NFTS, 7n),
      modifyLiquidity(1_300, POOL, NFTS, 7n, 5n),
      modifyLiquidity(1_300, POOL, NFTS, 8n),
      modifyLiquidity(1_400, OTHER, NFTS, 7n),
      modifyLiquidity(1_400, POOL, addr(0xf0d6), 7n),
      modifyLiquidity(1_400, POOL, NFTS, 7n, 1n, -60, 60),
    ];
    const seen = decodePositionLogs(logs, PM, window);
    expect(seen).toHaveLength(5);
    expect(seen.find((p) => p.poolId === POOL && p.key.owner === NFTS.toLowerCase() && p.key.salt === salt(7n) && p.key.tickLower === -600)?.block).toBe(1_200);
  });

  it("records a removal like an addition: the position exists either way", () => {
    expect(decodePositionLogs([modifyLiquidity(1_500, POOL, NFTS, 1n, -5n)], PM, window)).toHaveLength(1);
  });

  it("leaves out what isn't the PoolManager's event in this window", () => {
    const good = modifyLiquidity(1_500, POOL, NFTS, 1n);
    expect(decodePositionLogs([{ ...good, address: addr(0xbad) }], PM, window)).toEqual([]);
    expect(decodePositionLogs([{ ...good, removed: true }], PM, window)).toEqual([]);
    expect(decodePositionLogs([modifyLiquidity(999, POOL, NFTS, 1n), modifyLiquidity(2_000, POOL, NFTS, 1n)], PM, window)).toEqual([]);
    expect(decodePositionLogs([{ ...good, topics: [`0x${"11".repeat(32)}`, POOL, good.topics[2]!] }], PM, window)).toEqual([]);
    expect(decodePositionLogs([{ ...good, data: "0x1234" }], PM, window)).toEqual([]);
    expect(decodePositionLogs([{ ...good, topics: good.topics.slice(0, 2) }], PM, window)).toEqual([]);
    // A range that can't exist (lower not below upper) is nobody's position.
    expect(decodePositionLogs([modifyLiquidity(1_500, POOL, NFTS, 1n, 1n, 60, 60)], PM, window)).toEqual([]);
    expect(decodePositionLogs([good], PM.toLowerCase(), window)).toHaveLength(1);
  });
});

describe("decodePoolLogs", () => {
  const TOKEN = addr(0x70c3);
  const HOOK = addr(0x2544);

  it("reads each Initialize the pool index keeps as a pool doc: the key with its hook, the token and the quote", () => {
    expect(decodePoolLogs([v4Pool(1_500, TOKEN, POOL, HOOK)], "mainnet", window)).toEqual([
      {
        network: "mainnet", poolId: POOL, version: "v4", token: TOKEN, quote: "USDC-native", fee: 10_000, createdBlock: 1_500,
        key: { currency0: ZERO, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: HOOK }, depthUsdc: null, sampledAt: null,
      },
    ]);
  });

  it("leaves out everything else: positions, other contracts' pools, other blocks, a removed log, a pool once", () => {
    const init = v4Pool(1_500, TOKEN, POOL, HOOK);
    expect(decodePoolLogs([modifyLiquidity(1_500, POOL, NFTS, 1n), v3Pool(1_500, TOKEN, addr(0xb001))], "mainnet", window)).toEqual([]);
    expect(decodePoolLogs([v4Pool(999, TOKEN, POOL), v4Pool(2_000, TOKEN, OTHER)], "mainnet", window)).toEqual([]);
    expect(decodePoolLogs([{ ...init, removed: true }], "mainnet", window)).toEqual([]);
    expect(decodePoolLogs([{ ...init, address: addr(0xbad) }], "mainnet", window)).toEqual([]);
    expect(decodePoolLogs([init, { ...init, logIndex: "0x5" }], "mainnet", window)).toHaveLength(1);
    // The same logs give the positions and the pools, each from its own event.
    expect(decodePositionLogs([init, modifyLiquidity(1_500, POOL, NFTS, 1n)], PM, window)).toHaveLength(1);
  });
});

describe("the position index's settings", () => {
  it("starts at the PoolManager's deployment on mainnet, and keeps no index on testnet", () => {
    expect(UNISWAP_V4_FROM).toEqual({ mainnet: 1_948_056, testnet: null });
    expect(DEX.mainnet?.v4?.poolManager).toBe(PM);
  });

  it("hands an inspection no more positions than the Inspector reads", () => {
    expect(INDEXED_POSITIONS_LIMIT).toBe(MAX_POSITIONS_PER_POOL);
    expect(INDEXED_POSITIONS_TOTAL).toBe(MAX_POSITIONS);
  });

  it("lets the Inspector read the tail in one eth_getLogs: no more blocks than a window may span", () => {
    expect(TAIL_MAX_BLOCKS).toBeLessThanOrEqual(MAX_WINDOW);
  });

  it("keeps the step clear of the function's timeout: after the last inspection starts, and 20 s to spare after its last round of writes", () => {
    expect(POSITIONS_LIMITS.untilMs).toBeGreaterThan(LIMITS.inspectUntilMs);
    expect(POSITIONS_LIMITS.deadlineMs).toBeGreaterThan(POSITIONS_LIMITS.untilMs);
    expect(POSITIONS_LIMITS.writeUntilMs).toBeGreaterThanOrEqual(POSITIONS_LIMITS.deadlineMs);
    // A killed run stores nothing: no window starts in the last 30 s, and no round of writes in the last 20.
    expect(INDEXER_OPTIONS.timeoutSeconds * 1_000 - POSITIONS_LIMITS.untilMs).toBeGreaterThanOrEqual(30_000);
    expect(INDEXER_OPTIONS.timeoutSeconds * 1_000 - POSITIONS_LIMITS.writeUntilMs).toBeGreaterThanOrEqual(20_000);
    expect(POSITIONS_LIMITS.stepMs).toBeLessThanOrEqual(STATS_LIMITS.stepMs);
  });
});
