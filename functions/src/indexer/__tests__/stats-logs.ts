import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { ARCOS, FEE_KEYS, PREVIOUS_MULTISENDS, feeControllerAbi, multisendAbi, tokenFactoryAbi, type Address } from "@arcos/chain";
import type { RawLog } from "../events";

// Logs as eth_getLogs answers them, encoded from the contracts' exported ABIs, for the Stats tests.

const hex = (n: number): Hex => `0x${n.toString(16)}`;
export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
export const ZERO: Address = "0x0000000000000000000000000000000000000000";

export const FACTORY = ARCOS.mainnet!.tokenFactory;
export const FEE_CONTROLLER = ARCOS.mainnet!.feeController;
export const NEW_MULTISEND = ARCOS.mainnet!.multisend;
export const OLD_MULTISEND = PREVIOUS_MULTISENDS.mainnet[0]!;
/** The project wallet Stats leaves out. */
export const HOUSE: Address = "0x463A81a017326E9029DcCA2a2d9AA42599Bef12c";

/** A block time on Arc's cadence from a made-up genesis: 2026-11-01T00:00:00Z at block 0, two blocks a second. */
export const timeOf = (block: number): number => 1_793_500_000 + Math.floor(block / 2);

type Where = { block: number; logIndex?: number; timestamp?: number | null };
const place = ({ block, logIndex = 0, timestamp }: Where) => ({
  blockNumber: hex(block),
  logIndex: hex(logIndex),
  ...(timestamp === null ? {} : { blockTimestamp: hex(timestamp ?? timeOf(block)) }),
});

export function tokenCreated(where: Where, o: { creator?: Address; mintable?: boolean; burnable?: boolean; token?: Address } = {}): RawLog {
  const creator = o.creator ?? addr(0xc0ffee);
  return {
    address: FACTORY,
    topics: encodeEventTopics({
      abi: tokenFactoryAbi,
      eventName: "TokenCreated",
      args: { creator, token: o.token ?? addr(0x7000 + where.block), holder: creator },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "bool" }],
      ["Test Token", "TEST", 18, 10n ** 24n, 0n, o.mintable ?? false, o.burnable ?? false],
    ),
    ...place(where),
  };
}

export function drop(
  where: Where,
  o: { address?: Address; sender?: Address; token?: Address; recipients?: number; failed?: number; delivered?: bigint; failedAmount?: bigint } = {},
): RawLog {
  return {
    address: o.address ?? NEW_MULTISEND,
    topics: encodeEventTopics({ abi: multisendAbi, eventName: "Drop", args: { sender: o.sender ?? addr(0xd00d), token: o.token ?? ZERO } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [BigInt(o.recipients ?? 3), o.delivered ?? 3_000n, o.failedAmount ?? 0n, BigInt(o.failed ?? 0)],
    ),
    ...place(where),
  };
}

export type FeeName = keyof typeof FEE_KEYS;

export function keyAdded(where: Where, key: FeeName, value: bigint, cap: bigint = value * 10n): RawLog {
  return {
    address: FEE_CONTROLLER,
    topics: encodeEventTopics({ abi: feeControllerAbi, eventName: "KeyAdded", args: { key: FEE_KEYS[key] } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [value, cap]),
    ...place(where),
  };
}

export function feeChanged(where: Where, key: FeeName, value: bigint): RawLog {
  return {
    address: FEE_CONTROLLER,
    topics: encodeEventTopics({ abi: feeControllerAbi, eventName: "FeeChanged", args: { key: FEE_KEYS[key] } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    ...place(where),
  };
}

const USDC = 10n ** 18n;
/** The three fee keys Mint and Drop read, added as the FeeController's owner did: Mint 1, Drop 0.01 a recipient and 2 at least. */
export const seedFees = (block: number): RawLog[] => [
  keyAdded({ block, logIndex: 0 }, "MINT_FLAT", 1n * USDC),
  keyAdded({ block, logIndex: 1 }, "DROP_PER_RECIPIENT", USDC / 100n),
  keyAdded({ block, logIndex: 2 }, "DROP_MIN", 2n * USDC),
];
export { USDC };
