import { ARCOS, activeNetwork, type Address, type NetworkId } from "@arcos/chain";
import type { AppManifest } from "@arcos/shell";
import { about } from "./about/manifest";
import { bridge } from "./bridge/manifest";
import { drop } from "./drop/manifest";
import { finder } from "./finder/manifest";
import { inspector } from "./inspector/manifest";
import { meme } from "./meme/manifest";
import { mint } from "./mint/manifest";
import { radar } from "./radar/manifest";
import { revoke } from "./revoke/manifest";
import { swap } from "./swap/manifest";
import { terminal } from "./terminal/manifest";
import { wallet } from "./wallet/manifest";
import { watchdog } from "./watchdog/manifest";
import { SOON } from "./soon";

/** The live apps, in desktop order. Every app in the product is listed here or in SOON, and nowhere else. */
export const LIVE: AppManifest[] = [finder, inspector, watchdog, mint, drop, swap, bridge, radar, meme, wallet, about, revoke, terminal];

/** Which of 4rc.OS's own contracts in @arcos/chain's `ARCOS` an app acts through. */
export type ContractKey = "vaultFactory" | "vestingFactory" | "proPass";

/**
 * The apps that hold or move users' assets through a 4rc.OS contract, and the contract each needs (D6 of the R1/R2
 * design). Such an app is live only on a network where `ARCOS` names that contract. Elsewhere its grey stand-in in SOON
 * shows instead, so each of these needs one. Every other app is listed on both networks.
 *
 * No custodial contract gets a mainnet address before the audit gates, so the live apps appear on the testnet site
 * first, one by one as their contracts are set, and on 4rc.OS only when mainnet's are. Watchdog Pro joins with
 * `proPass` when it ships.
 */
export const NEEDS_CONTRACT: Readonly<Record<string, ContractKey>> = {
  vault: "vaultFactory",
  vesting: "vestingFactory",
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

/**
 * The address a network's contracts give `key`, or null when there is none. Read loosely, since the R1 contracts are
 * optional fields of `ARCOS` (null until deployed): anything but a non-zero 20-byte hex address reads as not set.
 */
export function contractAddress(contracts: object | null | undefined, key: ContractKey): Address | null {
  const value: unknown = contracts ? (contracts as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && ADDRESS.test(value) && !ZERO.test(value) ? (value as Address) : null;
}

type Sources = {
  live?: AppManifest[];
  soon?: AppManifest[];
  needs?: Readonly<Record<string, ContractKey>>;
  /** The network's contracts: `ARCOS[network]` unless given. */
  contracts?: object | null;
};

/**
 * The apps a site built for `network` lists, in desktop order: the live apps, less those whose contract isn't set
 * there, then the grey apps, less those whose live app is listed.
 */
export function appsFor(network: NetworkId, sources: Sources = {}): AppManifest[] {
  const { live = LIVE, soon = SOON, needs = NEEDS_CONTRACT } = sources;
  const contracts = "contracts" in sources ? sources.contracts : ARCOS[network];
  const listed = live.filter((m) => !Object.hasOwn(needs, m.id) || contractAddress(contracts, needs[m.id]) !== null);
  const liveIds = new Set(listed.map((m) => m.id));
  return [...listed, ...soon.filter((m) => !liveIds.has(m.id))];
}

/** What this build lists: the network is fixed when the site is built (NEXT_PUBLIC_ARC_NETWORK). */
export const APPS: AppManifest[] = appsFor(activeNetwork());
