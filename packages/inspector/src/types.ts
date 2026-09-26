import type { Abi } from "viem";
import type { Address, DexConfig, NetworkId } from "@arcos/chain";
import type { Hex } from "./bytecode";
import type { ExplorerSource } from "./explorer";

/** The call reached the chain and reverted (or returned no data): the function isn't there, or it said no. */
export class CallReverted extends Error {
  constructor(message = "execution reverted") {
    super(message);
    this.name = "CallReverted";
  }
}

export type Status = "pass" | "warn" | "fail" | "unknown";
export type CheckId = "verified" | "ownership" | "privileges" | "proxy" | "holders" | "liquidity" | "lp-lock" | "prevrandao";

export type Finding = {
  id: CheckId;
  status: Status;
  title: string;
  detail: string;
  evidenceUrl: string | null;
  fixAppId: "vault" | "vesting" | null;
};

export type Report = {
  address: Address;
  network: NetworkId;
  token: { name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null };
  findings: Finding[];
  /** Kept for compatibility: passed === counts.pass, total === findings.length. */
  passed: number;
  total: number;
  /** The same numbers, broken out by status — every surface should show `unknown` explicitly rather than folding it into "not pass". */
  counts: { pass: number; warn: number; fail: number; unknown: number };
  explorerReachable: boolean;
  blockNumber: string;
  generatedAt: string;
};

/** The few chain reads the checks need. Small on purpose: trivial to fake in tests. */
export interface ChainReader {
  getCode(address: Address): Promise<Hex | null>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | null>;
  /**
   * Rejects with `CallReverted` when the call reverts or returns no data. Any other rejection is
   * a transport failure and means nothing about the contract.
   */
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
  blockNumber(): Promise<bigint>;
}

export type InspectInput = {
  address: Address;
  network: NetworkId;
  reader: ChainReader;
  explorer: ExplorerSource | null;
  dex: DexConfig | null;
  knownLockers: Address[];
  /** e.g. https://explorer.arc.io — evidence links are built from it. */
  explorerBase: string;
  /** The 4rc.OS TokenFactory on this network. A token it created (`isArcosToken`) runs one of the factory's fixed
   * templates, whose source is published with the factory's verified source. */
  arcosTokenFactory?: Address | null;
  now?: () => Date;
};
