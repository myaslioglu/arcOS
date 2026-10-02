import { decodeEventLog, parseAbi, toEventSelector, type Abi, type Hex } from "viem";
import { ARCOS, DEX, tokenFactoryAbi, type Address, type NetworkId } from "@arcos/chain";
import type { PoolVersion, TokenSource } from "@arcos/data";

/** One log as `eth_getLogs` answers it (hex quantities). `blockTimestamp` is Arc's addition; older nodes leave it out. */
export type RawLog = {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  blockTimestamp?: Hex;
  removed?: boolean;
};

// Each event in an ABI of its own: Uniswap v3 and Aerodrome Slipstream both call theirs PoolCreated, with other fields.
const pairCreatedAbi = parseAbi(["event PairCreated(address indexed token0, address indexed token1, address pair, uint256 length)"]);
const v3PoolCreatedAbi = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);
const initializeAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
/** Slipstream's CLFactory: the tick spacing in place of v3's fee, and no fee in the event. */
const aeroPoolCreatedAbi = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)",
]);
const tokenCreatedAbi = tokenFactoryAbi.filter((item) => item.type === "event" && item.name === "TokenCreated") as Abi;

const selector = (abi: Abi): Hex => {
  const event = abi.find((item) => item.type === "event");
  if (!event || event.type !== "event") throw new Error("no event in the ABI");
  return toEventSelector(event);
};

/** topic0 of each event the indexer reads. */
export const TOPICS = {
  tokenCreated: selector(tokenCreatedAbi),
  pairCreated: selector(pairCreatedAbi),
  v3PoolCreated: selector(v3PoolCreatedAbi),
  initialize: selector(initializeAbi),
  aeroPoolCreated: selector(aeroPoolCreatedAbi),
} as const;

/** One contract the indexer reads, with the one event it reads from it. */
export type Source = { kind: TokenSource; address: Address; topic0: Hex; abi: Abi };

/**
 * The contracts and events of design 1.3, step 4: the 4rc.OS TokenFactory, the Uniswap v2 and v3 factories, the v4
 * PoolManager and the Aerodrome Slipstream factory, as far as the network has them. Five addresses, under the 20 a
 * filter may name (F6).
 */
export function sourcesFor(network: NetworkId): Source[] {
  const dex = DEX[network];
  const factory = ARCOS[network]?.tokenFactory;
  const all: (Source | null)[] = [
    factory ? { kind: "factory", address: factory, topic0: TOPICS.tokenCreated, abi: tokenCreatedAbi } : null,
    dex?.v2Factory ? { kind: "v2", address: dex.v2Factory, topic0: TOPICS.pairCreated, abi: pairCreatedAbi } : null,
    dex?.v3Factory ? { kind: "v3", address: dex.v3Factory, topic0: TOPICS.v3PoolCreated, abi: v3PoolCreatedAbi } : null,
    dex?.v4 ? { kind: "v4", address: dex.v4.poolManager, topic0: TOPICS.initialize, abi: initializeAbi } : null,
    dex?.aero ? { kind: "aero", address: dex.aero.clFactory, topic0: TOPICS.aeroPoolCreated, abi: aeroPoolCreatedAbi } : null,
  ];
  return all.filter((source): source is Source => source !== null);
}

/** Where a sighting sits on the chain, and when. */
export type LogPosition = { block: number; logIndex: number; timestamp: number | null };

/** A token the 4rc.OS TokenFactory created. */
export type TokenSighting = LogPosition & {
  kind: "token";
  token: Address;
  creator: Address;
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: bigint;
};

/**
 * A pool between two currencies, as its factory or the PoolManager announced it. `id` is the pool's address, or for v4
 * the pool id. `fee` is in hundredths of a basis point (v2 is a fixed 0.3%; Slipstream's event carries none).
 */
export type PoolSighting = LogPosition & {
  kind: "pool";
  version: PoolVersion;
  id: string;
  currency0: Address;
  currency1: Address;
  fee: number | null;
  tickSpacing: number | null;
  hooks: Address | null;
};

export type Sighting = TokenSighting | PoolSighting;

const V2_FEE = 3000;
const lower = (value: string) => value.toLowerCase() as Address;
const quantity = (hex: Hex | undefined): number | null => (hex === undefined ? null : Number(BigInt(hex)));

/**
 * Decodes one log by its emitter and topic0 together: a log from an address the indexer doesn't read, an event it doesn't
 * read from that address, a removed log, or one that doesn't decode is null. Addresses come out lowercase.
 */
export function decodeLog(log: RawLog, sources: readonly Source[]): Sighting | null {
  if (log.removed) return null;
  const topic0 = log.topics[0]?.toLowerCase();
  const source = sources.find((s) => s.address.toLowerCase() === log.address.toLowerCase() && s.topic0 === topic0);
  if (!source) return null;
  let args: Record<string, unknown>;
  try {
    args = decodeEventLog({ abi: source.abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true }).args as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  const at: LogPosition = { block: Number(BigInt(log.blockNumber)), logIndex: Number(BigInt(log.logIndex)), timestamp: quantity(log.blockTimestamp) };
  switch (source.kind) {
    case "factory":
      return {
        ...at,
        kind: "token",
        token: lower(args.token as string),
        creator: lower(args.creator as string),
        name: args.name as string,
        symbol: args.symbol as string,
        decimals: Number(args.decimals),
        initialSupply: args.initialSupply as bigint,
      };
    case "v2":
      return pool(at, "v2", args.pair as string, args, V2_FEE, null, null);
    case "v3":
      return pool(at, "v3", args.pool as string, args, Number(args.fee), Number(args.tickSpacing), null);
    case "aero":
      return pool(at, "aero", args.pool as string, args, null, Number(args.tickSpacing), null);
    case "v4":
      return {
        ...at,
        kind: "pool",
        version: "v4",
        id: (args.id as string).toLowerCase(),
        currency0: lower(args.currency0 as string),
        currency1: lower(args.currency1 as string),
        fee: Number(args.fee),
        tickSpacing: Number(args.tickSpacing),
        hooks: lower(args.hooks as string),
      };
  }
}

function pool(
  at: LogPosition,
  version: PoolVersion,
  id: string,
  args: Record<string, unknown>,
  fee: number | null,
  tickSpacing: number | null,
  hooks: Address | null,
): PoolSighting {
  return { ...at, kind: "pool", version, id: lower(id), currency0: lower(args.token0 as string), currency1: lower(args.token1 as string), fee, tickSpacing, hooks };
}

/** Every sighting in a window's logs, in chain order (block, then log index), whatever order the node sent them in. */
export function decodeLogs(logs: readonly RawLog[], sources: readonly Source[]): Sighting[] {
  return logs
    .map((log) => decodeLog(log, sources))
    .filter((s): s is Sighting => s !== null)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}
