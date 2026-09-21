import { getAddress } from "viem";
import type { Address } from "@arcos/chain";
import { extractSelectors, minimalProxyTarget, usesOpcode } from "./bytecode";
import {
  BEACON_SLOT, IMPL_SLOT, addressFromSlot, beaconImplementation, checkHolders, checkLiquidity, checkLpLock,
  checkOwnership, checkPrevrandao, checkPrivileges, checkProxy, checkVerified, erc20Abi, findPools, resolveOwner,
  slotSet, type LogicGap,
} from "./checks";
import { combinePrivileges, type Privilege } from "./privileges";
import type { ContractInfo, Holder, TokenInfo } from "./explorer";
import { cleanLabel } from "./label";
import type { CheckId, Finding, InspectInput, Report } from "./types";

export class NotAContract extends Error {
  constructor(address: string) {
    super(`${address} has no code`);
    this.name = "NotAContract";
  }
}

const ORDER: CheckId[] = ["verified", "ownership", "privileges", "proxy", "holders", "liquidity", "lp-lock", "prevrandao"];
const DELEGATECALL = 0xf4;

/** A check that throws becomes an "unknown" finding; one bad RPC call never sinks the report. The
 * real error is logged for operators — it never reaches the report, which could otherwise leak
 * internal URLs or other transport detail to whoever's reading the finding. */
async function guard(id: CheckId, run: () => Finding | Promise<Finding>): Promise<Finding> {
  try {
    return await run();
  } catch (e) {
    console.error(`inspector: check "${id}" failed`, e);
    return { id, status: "unknown", title: "This check couldn't run", detail: "This check couldn't run — the network didn't answer.", evidenceUrl: null, fixAppId: null };
  }
}

/** Tolerant of anything a third-party API might send for a "number" — never lets a malformed
 * value like "1.5e21" throw and sink the whole inspection. */
function tryBig(v: string | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

export async function inspect(rawInput: InspectInput): Promise<Report> {
  // Checksum once so `Report.address` (and every evidence URL built from `input.address`) is
  // consistent regardless of the casing whoever triggered this inspection happened to pass in.
  const input: InspectInput = { ...rawInput, address: getAddress(rawInput.address) };
  const { reader, explorer, address } = input;
  const code = await reader.getCode(address);
  if (!code) throw new NotAContract(address);

  const cloneOf = minimalProxyTarget(code);
  // For a clone, NEVER fall back to its own trampoline bytecode — that's not the logic that runs.
  // A thrown error (transport failure — "couldn't read it") is kept distinct from a clean `null`
  // return (the read succeeded and the target genuinely has no code) — one is `unknown`, the other
  // is a `fail`, and conflating them was exactly the bug: a failed read must never look like a pass.
  let cloneImplCode: string | null = null;
  let cloneReadFailed = false;
  if (cloneOf) {
    try {
      cloneImplCode = await reader.getCode(cloneOf);
    } catch {
      cloneReadFailed = true;
    }
  }
  const cloneResolved = cloneOf !== null && cloneImplCode !== null;
  const cloneTargetEmpty = cloneOf !== null && !cloneReadFailed && cloneImplCode === null;

  // Resolve what code actually runs, and what (if anything) this address's own EIP-1967 slots say.
  // These three outcomes are mutually exclusive:
  let topSlotsError: unknown = null;
  let topSlotsSet = false;
  let cloneTargetIsProxy = false;
  let targetSlotsRead = true;
  let proxyImpl: Address | null = null;
  let logicCode: string | null;
  let logicGap: LogicGap | null = null;

  /** Reads the code at a resolved logic address. A thrown read ("couldn't read it") and an empty
   * answer ("that address holds no code") both leave nothing to score, but they aren't the same
   * fact, so they don't share a message. Neither is ever evidence of a clean contract. */
  const readLogic = async (at: Address | null): Promise<[string | null, LogicGap | null]> => {
    if (!at) return [null, "logic-unreadable"];
    try {
      const fetched = await reader.getCode(at);
      return fetched === null ? [null, "logic-empty"] : [fetched, null];
    } catch {
      return [null, "logic-unreadable"];
    }
  };

  if (cloneOf === null) {
    const slots = await Promise.all([reader.getStorageAt(address, IMPL_SLOT), reader.getStorageAt(address, BEACON_SLOT)]).catch((e: unknown) => {
      topSlotsError = e;
      return null;
    });
    if (slots) topSlotsSet = slotSet(slots[0]) || slotSet(slots[1]);
    if (topSlotsSet) {
      // An EIP-1967 proxy's own bytecode is a trampoline with no function dispatcher: scoring it
      // would report "no privileged functions" about a token whose implementation can mint. The
      // implementation slot wins over the beacon slot when both are set, exactly as the EVM's own
      // ERC-1967 lookup does.
      proxyImpl = addressFromSlot(slots![0]) ?? (await beaconImplementation(reader, addressFromSlot(slots![1])));
      [logicCode, logicGap] = await readLogic(proxyImpl);
    } else {
      logicCode = code;
    }
  } else if (!cloneResolved) {
    // The target's code either couldn't be fetched (transport failure) or came back empty (the
    // clone points at nothing) — either way there's no logic to read, so nothing downstream of it
    // can be scored. `checkProxy` itself still distinguishes the two (unknown vs. fail).
    logicCode = null;
    logicGap = cloneReadFailed ? "logic-unreadable" : "logic-empty";
  } else {
    // The clone's target was fetched — check whether the TARGET is itself an upgradeable proxy.
    // A slot read that THREW says nothing: without it, "no slot is set" is an assumption, not a
    // reading, so `checkProxy` must not turn it into "not upgradeable".
    const readTargetSlot = (slot: typeof IMPL_SLOT | typeof BEACON_SLOT) =>
      reader.getStorageAt(cloneOf, slot).catch(() => {
        targetSlotsRead = false;
        return null;
      });
    const [tImpl, tBeacon] = await Promise.all([readTargetSlot(IMPL_SLOT), readTargetSlot(BEACON_SLOT)]);
    cloneTargetIsProxy = slotSet(tImpl) || slotSet(tBeacon);
    if (!cloneTargetIsProxy) {
      logicCode = cloneImplCode;
    } else {
      // One level of further resolution is enough — a proxy-of-a-proxy-of-a-proxy stays unknown.
      // A beacon slot holds the BEACON's address, not the logic's, so it needs its own call.
      const grandAddr = addressFromSlot(tImpl) ?? (await beaconImplementation(reader, addressFromSlot(tBeacon)));
      [logicCode, logicGap] = await readLogic(grandAddr);
    }
  }

  // Code that delegates calls but resolves to no known clone target or EIP-1967 slot: the engine
  // never read the code that actually runs, so it must not score anything downstream of it.
  const forwardsToUnidentifiedCode = cloneOf === null && !topSlotsSet && usesOpcode(code, DELEGATECALL);
  if (forwardsToUnidentifiedCode) {
    logicCode = null;
    logicGap = "delegates-to-unidentified";
  }
  // Last net, for every path above: code with no function dispatcher at all that still delegates
  // calls is another trampoline, not the logic — whatever chain of proxies led here wasn't followed
  // to the end, so there is nothing to score.
  if (logicCode !== null && extractSelectors(logicCode).size === 0 && usesOpcode(logicCode, DELEGATECALL)) {
    logicCode = null;
    logicGap = "logic-unidentified";
  }

  const selectors = extractSelectors(logicCode ?? "0x");

  let explorerReachable = explorer !== null;
  const ask = async <T>(call: () => Promise<T>): Promise<T | null> => {
    if (!explorer) return null;
    try {
      return await call();
    } catch {
      explorerReachable = false;
      return null;
    }
  };

  const [contract, implContract, tokenInfo, holders, owner, poolScan, blockNumber] = await Promise.all([
    ask<ContractInfo>(() => explorer!.contract(address)),
    // For a proxy, the ABI that describes what can be called is the IMPLEMENTATION's: Blockscout's
    // record for the proxy address is the proxy's own, and "the proxy's ABI has no privileged
    // functions" says nothing about the logic behind it.
    proxyImpl && logicCode !== null ? ask<ContractInfo>(() => explorer!.contract(proxyImpl!)) : Promise.resolve(null),
    ask<TokenInfo | null>(() => explorer!.token(address)),
    ask<Holder[] | null>(() => explorer!.topHolders(address)),
    resolveOwner(reader, address, selectors),
    findPools(input).catch(() => null),
    reader.blockNumber().catch(() => null),
  ]);

  const readOr = async <T>(fn: string, fallback: T): Promise<T> => (reader.read(address, erc20Abi, fn) as Promise<T>).catch(() => fallback);
  const [name, symbol, decimals, supply] = await Promise.all([
    readOr<string | null>("name", tokenInfo?.name ?? null),
    readOr<string | null>("symbol", tokenInfo?.symbol ?? null),
    readOr<number | null>("decimals", tokenInfo?.decimals ?? null),
    readOr<bigint | null>("totalSupply", tryBig(tokenInfo?.totalSupply ?? null)),
  ]);

  // The ABI is only evidence about the code that actually runs: the token's own for a plain
  // contract, the implementation's for an EIP-1967 proxy, and none at all for a clone (whose
  // explorer record describes the trampoline).
  const abiForPrivileges = cloneOf !== null ? null : topSlotsSet ? (implContract?.abi ?? null) : (contract?.abi ?? null);
  const found: Privilege[] | null = logicCode === null ? null : combinePrivileges(abiForPrivileges, selectors);

  const findings = await Promise.all([
    guard("verified", () => checkVerified(input, contract)),
    guard("ownership", () => checkOwnership(input, owner, found)),
    guard("privileges", () => checkPrivileges(input, found, logicGap, owner)),
    guard("proxy", () => {
      if (cloneOf === null && topSlotsError) throw topSlotsError;
      return checkProxy(input, { cloneOf, cloneReadFailed, cloneTargetEmpty, cloneTargetIsProxy, targetSlotsRead, forwardsToUnidentifiedCode, topSlotsSet });
    }),
    guard("holders", () => checkHolders(input, holders, supply, poolScan, tokenInfo?.holdersCount ?? null)),
    guard("liquidity", () => checkLiquidity(input, poolScan)),
    guard("lp-lock", () => checkLpLock(input, poolScan)),
    guard("prevrandao", () => checkPrevrandao(input, logicCode, logicGap)),
  ]);
  findings.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

  const counts = {
    pass: findings.filter((f) => f.status === "pass").length,
    warn: findings.filter((f) => f.status === "warn").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };

  return {
    address,
    network: input.network,
    token: {
      name: cleanLabel(name, 64),
      symbol: cleanLabel(symbol, 32),
      decimals: decimals === null ? null : Number(decimals),
      totalSupply: supply === null ? null : supply.toString(),
    },
    findings,
    passed: counts.pass,
    total: findings.length,
    counts,
    explorerReachable,
    blockNumber: blockNumber === null ? "unknown" : blockNumber.toString(),
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}
