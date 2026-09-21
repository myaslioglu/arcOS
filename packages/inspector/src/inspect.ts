import { getAddress } from "viem";
import { extractSelectors, minimalProxyTarget, usesOpcode } from "./bytecode";
import {
  BEACON_SLOT, IMPL_SLOT, addressFromSlot, checkHolders, checkLiquidity, checkLpLock, checkOwnership,
  checkPrevrandao, checkPrivileges, checkProxy, checkVerified, erc20Abi, findPools, resolveOwner, slotSet,
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
  let logicCode: string | null;

  if (cloneOf === null) {
    const slots = await Promise.all([reader.getStorageAt(address, IMPL_SLOT), reader.getStorageAt(address, BEACON_SLOT)]).catch((e: unknown) => {
      topSlotsError = e;
      return null;
    });
    if (slots) topSlotsSet = slotSet(slots[0]) || slotSet(slots[1]);
    logicCode = code;
  } else if (!cloneResolved) {
    // The target's code either couldn't be fetched (transport failure) or came back empty (the
    // clone points at nothing) — either way there's no logic to read, so nothing downstream of it
    // can be scored. `checkProxy` itself still distinguishes the two (unknown vs. fail).
    logicCode = null;
  } else {
    // The clone's target was fetched — check whether the TARGET is itself an upgradeable proxy.
    const [tImpl, tBeacon] = await Promise.all([
      reader.getStorageAt(cloneOf, IMPL_SLOT).catch(() => null),
      reader.getStorageAt(cloneOf, BEACON_SLOT).catch(() => null),
    ]);
    cloneTargetIsProxy = slotSet(tImpl) || slotSet(tBeacon);
    if (!cloneTargetIsProxy) {
      logicCode = cloneImplCode;
    } else {
      // One level of further resolution is enough — a proxy-of-a-proxy-of-a-proxy stays unknown.
      const grandAddr = addressFromSlot(tImpl) ?? addressFromSlot(tBeacon);
      logicCode = grandAddr ? await reader.getCode(grandAddr).catch(() => null) : null;
    }
  }

  // Code that delegates calls but resolves to no known clone target or EIP-1967 slot: the engine
  // never read the code that actually runs, so it must not score anything downstream of it.
  const forwardsToUnidentifiedCode = cloneOf === null && !topSlotsSet && usesOpcode(code, DELEGATECALL);
  if (forwardsToUnidentifiedCode) logicCode = null;

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

  const [contract, tokenInfo, holders, owner, pools, blockNumber] = await Promise.all([
    ask<ContractInfo>(() => explorer!.contract(address)),
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

  const abiForPrivileges = cloneOf === null ? (contract?.abi ?? null) : null;
  const found: Privilege[] | null = logicCode === null ? null : combinePrivileges(abiForPrivileges, selectors);

  const findings = await Promise.all([
    guard("verified", () => checkVerified(input, contract ? contract.verified : null)),
    guard("ownership", () => checkOwnership(input, owner, found)),
    guard("privileges", () => checkPrivileges(input, found, forwardsToUnidentifiedCode, owner)),
    guard("proxy", () => {
      if (cloneOf === null && topSlotsError) throw topSlotsError;
      return checkProxy(input, { cloneOf, cloneReadFailed, cloneTargetEmpty, cloneTargetIsProxy, forwardsToUnidentifiedCode, topSlotsSet });
    }),
    guard("holders", () => checkHolders(input, holders, supply, pools)),
    guard("liquidity", () => checkLiquidity(input, pools)),
    guard("lp-lock", () => checkLpLock(input, pools)),
    guard("prevrandao", () => checkPrevrandao(input, logicCode, forwardsToUnidentifiedCode)),
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
