import type { Abi } from "viem";
import type { Address, DexConfig, NetworkId } from "@arcos/chain";
import type { Hex } from "./bytecode";
import type { ExplorerSource } from "./explorer";

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
  passed: number;
  total: number;
  explorerReachable: boolean;
  blockNumber: string;
  generatedAt: string;
};

/** The few chain reads the checks need. Small on purpose: trivial to fake in tests. */
export interface ChainReader {
  getCode(address: Address): Promise<Hex | null>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | null>;
  /** Rejects when the call reverts. */
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
  now?: () => Date;
};
