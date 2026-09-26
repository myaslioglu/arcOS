import { getAddress } from "viem";
import { tokenFactoryAbi, type Address } from "@arcos/chain";
import { extractSelectors, minimalProxyTarget, usesOpcode } from "./bytecode";
import {
  ADMIN_SLOT, BEACON_SLOT, IMPL_SLOT, abiDeclaresTransfer, addressFromSlot, beaconImplementation, checkHolders,
  checkLiquidity, checkLpLock, checkOwnership, checkPrevrandao, checkPrivileges, checkProxy, checkVerified,
  dispatcherInBytecode, erc20Abi, findPools, gateLogicPass, resolveOwner, slotReadable, slotSet,
  type LogicBlock, type LogicGap,
} from "./checks";
import { combinePrivileges, type Privilege } from "./privileges";
import type { ContractInfo, HolderPage, TokenInfo } from "./explorer";
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
  let logicCode: string | null;
  let logicGap: LogicGap | null = null;
  /** Where the code that runs lives, when that isn't this token's own code. `null` covers both
   * "this token runs its own code" and "it demonstrably forwards, but to something that couldn't be
   * identified" — `runsOtherCode` below tells those two apart. */
  let logicAt: Address | null = null;
  /** Set when `vet` has already been applied to `logicAt`: the clone path runs it inline with the
   * slot read it has just made, and the general pass below would only repeat those two reads. */
  let logicVetted = false;

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

  type ProxySlots = { read: boolean; impl: Address | null; beacon: Address | null };
  const readProxySlots = async (at: Address): Promise<ProxySlots> => {
    try {
      const [impl, beacon] = await Promise.all([reader.getStorageAt(at, IMPL_SLOT), reader.getStorageAt(at, BEACON_SLOT)]);
      // A malformed answer is no more an answer than a rejected call — see `slotReadable`.
      if (!slotReadable(impl) || !slotReadable(beacon)) return { read: false, impl: null, beacon: null };
      return { read: true, impl: addressFromSlot(impl), beacon: addressFromSlot(beacon) };
    } catch {
      return { read: false, impl: null, beacon: null };
    }
  };

  /**
   * One rule for every address the engine resolves as "the logic": it is only the logic if it
   * isn't a proxy in its own right. A TransparentUpgradeableProxy, most BeaconProxy builds and any
   * proxy with a function of its own all have a dispatcher, so "has no dispatcher" catches none of
   * them — its EIP-1967 slots and its clone shape do. One hop is all this engine follows, so a
   * second one is simply unidentified; and a slot that wouldn't read leaves "it isn't a proxy" as
   * an assumption, which is not something to score a report on.
   */
  const vet = (codeAt: string, slots: ProxySlots): LogicGap | null => {
    if (!slots.read) return "logic-unreadable";
    return minimalProxyTarget(codeAt) || slots.impl || slots.beacon ? "logic-unidentified" : null;
  };

  if (cloneOf === null) {
    const slots = await Promise.all([reader.getStorageAt(address, IMPL_SLOT), reader.getStorageAt(address, BEACON_SLOT)]).catch((e: unknown) => {
      topSlotsError = e;
      return null;
    });
    // A malformed answer is treated exactly like a read that threw: `checkProxy` rethrows it and
    // the logic block refuses to score this code (see `slotReadable`).
    if (slots && (!slotReadable(slots[0]) || !slotReadable(slots[1]))) topSlotsError = new Error("malformed storage answer");
    if (slots && !topSlotsError) topSlotsSet = slotSet(slots[0]) || slotSet(slots[1]);
    if (topSlotsSet) {
      // An EIP-1967 proxy's own bytecode is a trampoline with no function dispatcher: scoring it
      // would report "no privileged functions" about a token whose implementation can mint.
      const implSlot = addressFromSlot(slots![0]);
      const beaconSlot = addressFromSlot(slots![1]);
      if (implSlot && beaconSlot) {
        // Nothing in the EVM resolves this: the proxy's OWN BYTECODE decides which slot it reads,
        // and a BeaconProxy with a stale or decoy implementation slot would be scored on code that
        // never runs. Two candidates is no candidate.
        logicCode = null;
        logicGap = "logic-ambiguous";
      } else {
        // A beacon slot holds the BEACON's address, not the logic's, so it needs its own call.
        logicAt = implSlot ?? (await beaconImplementation(reader, beaconSlot));
        [logicCode, logicGap] = await readLogic(logicAt);
      }
    } else {
      // This address's own code. Its slots are unset — or the read THREW, which is not the same
      // thing: `topSlotsError` carries that, `checkProxy` rethrows it, and the logic block below
      // refuses to score this code as "the code that runs" on the strength of an answer nobody got.
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
    const targetSlots = await readProxySlots(cloneOf);
    targetSlotsRead = targetSlots.read;
    cloneTargetIsProxy = targetSlots.impl !== null || targetSlots.beacon !== null;
    if (!cloneTargetIsProxy) {
      // The target's slots have just been read, so `vet` only has the clone-of-a-clone shape (and
      // the unread-slot case) left to rule out.
      logicGap = vet(cloneImplCode!, targetSlots);
      logicCode = logicGap === null ? cloneImplCode : null;
      logicAt = cloneOf;
      logicVetted = true;
    } else {
      // One level of further resolution is enough — a proxy-of-a-proxy-of-a-proxy stays unknown.
      // A beacon slot holds the BEACON's address, not the logic's, so it needs its own call.
      const grandAddr = targetSlots.impl ?? (await beaconImplementation(reader, targetSlots.beacon));
      [logicCode, logicGap] = await readLogic(grandAddr);
      logicAt = grandAddr;
    }
  }

  // Everything resolved from somewhere else has to answer for itself before it can be scored.
  if (logicCode !== null && logicAt !== null && !logicVetted) {
    const gap = vet(logicCode, await readProxySlots(logicAt));
    if (gap !== null) {
      logicCode = null;
      logicGap = gap;
    }
  }

  // The ONE value behind both `proxy`'s upgradeability fail and R1's block on the logic checks.
  const upgradeable = cloneOf === null ? topSlotsSet : cloneTargetIsProxy;
  // Whose slots make it upgradeable — this address's own, or the clone target's. That is also
  // where the admin slot lives, and the page to link as evidence for "someone can replace this".
  const upgradeableAt: Address | null = !upgradeable ? null : cloneOf === null ? address : cloneOf;
  // A failed admin read is not evidence of an empty slot, but it makes no difference to what can
  // be said: without an address, both are "whoever controls upgrades".
  const admin: Address | null = upgradeableAt
    ? await reader.getStorageAt(upgradeableAt, ADMIN_SLOT).then(addressFromSlot, () => null)
    : null;

  // Code that delegates calls but resolves to no known clone target or EIP-1967 slot. `checkProxy`
  // reports this shape on its own; what it must NOT do is discard the contract's own dispatcher,
  // whose privileged selectors are real evidence. Everything it can't vouch for is blocked by the
  // DELEGATECALL rule below instead — the same rule on every path.
  const forwardsToUnidentifiedCode = cloneOf === null && !topSlotsSet && usesOpcode(code, DELEGATECALL);
  /** The scored logic runs code from an address this engine never identified. Read by the `proxy`
   * check (a clone whose logic does this isn't "not replaceable" after all) and by the gate on the
   * three logic checks — one fact, one place. */
  const logicDelegates = logicCode !== null && usesOpcode(logicCode, DELEGATECALL);
  /** This token demonstrably runs code that isn't its own: a clone, or its EIP-1967 slots are set.
   * Whether that code was actually identified is `logicAt`. Drives which record the ABI evidence
   * comes from — for a contract that merely DELEGATECALLs, its OWN record still describes the
   * dispatcher being scored, so that case is deliberately not in here. */
  const runsOtherCode = cloneOf !== null || topSlotsSet;
  /** ...but for `verified` it is: "anyone can read what this contract does" is false of any address
   * whose behaviour is decided somewhere else, including a DELEGATECALL to an address that couldn't
   * be identified at all. */
  const forwardsCalls = runsOtherCode || forwardsToUnidentifiedCode;

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

  const [contract, logicContract, tokenInfo, holderPage, owner, poolScan, blockNumber, arcosTemplate] = await Promise.all([
    ask<ContractInfo>(() => explorer!.contract(address)),
    // For anything that forwards, the record that matters is the one for the code that RUNS:
    // Blockscout's record for a proxy or a clone address describes the forwarding code, and
    // "the proxy's ABI has no privileged functions" says nothing about the logic behind it.
    logicAt ? ask<ContractInfo>(() => explorer!.contract(logicAt!)) : Promise.resolve(null),
    ask<TokenInfo | null>(() => explorer!.token(address)),
    ask<HolderPage | null>(() => explorer!.topHolders(address)),
    resolveOwner(reader, address, selectors),
    findPools(input).catch(() => null),
    reader.blockNumber().catch(() => null),
    input.arcosTokenFactory
      ? reader.read(input.arcosTokenFactory, tokenFactoryAbi, "isArcosToken", [address]).then((v) => v === true).catch(() => null)
      : Promise.resolve(null),
  ]);

  const readOr = async <T>(fn: string, fallback: T): Promise<T> => (reader.read(address, erc20Abi, fn) as Promise<T>).catch(() => fallback);
  const [name, symbol, decimals, supply] = await Promise.all([
    readOr<string | null>("name", tokenInfo?.name ?? null),
    readOr<string | null>("symbol", tokenInfo?.symbol ?? null),
    readOr<number | null>("decimals", tokenInfo?.decimals ?? null),
    readOr<bigint | null>("totalSupply", tryBig(tokenInfo?.totalSupply ?? null)),
  ]);

  // The ABI is only evidence about the code that actually runs: this address's own record for a
  // plain contract, and the resolved implementation's for anything that forwards (an EIP-1967
  // proxy or an EIP-1167 clone) — never the forwarding contract's own.
  const abiForPrivileges = runsOtherCode ? (logicContract?.abi ?? null) : (contract?.abi ?? null);
  const found: Privilege[] | null = logicCode === null ? null : combinePrivileges(abiForPrivileges, selectors);

  // What stops the three logic checks from reaching a `pass` — see `LogicBlock` for each reason and
  // why they rank this way. Applied after the checks, in one place, so no check can grow a new
  // pass path that quietly escapes it. (`logicCode === null` needs nothing: those checks already
  // answer `unknown` from `logicGap`.)
  const dispatcherInCode = dispatcherInBytecode(selectors);
  const dispatcherRead = dispatcherInCode || abiDeclaresTransfer(abiForPrivileges);
  /** `forOpcodes` is `prevrandao`'s variant: a published ABI can vouch for a dispatcher this engine
   * couldn't parse, but nothing about a list of functions vouches for the INSTRUCTIONS in the code,
   * so that check only accepts the bytecode half. */
  const blockFor = (forOpcodes: boolean): LogicBlock | null =>
    logicCode === null ? null
    : topSlotsError !== null ? { kind: "forwards-unknown" }
    : logicDelegates ? { kind: "delegatecall" }
    : !(forOpcodes ? dispatcherInCode : dispatcherRead) ? { kind: forOpcodes ? "opcodes" : "dispatcher" }
    : upgradeableAt !== null ? { kind: "mutable", admin, proxy: upgradeableAt, privileged: (found?.length ?? 0) > 0 }
    : null;
  const gate = (f: Finding): Finding => gateLogicPass(input, f, blockFor(false));
  const gateOpcodes = (f: Finding): Finding => gateLogicPass(input, f, blockFor(true));

  const findings = await Promise.all([
    // `logicAt` is where the code that runs WOULD live; it is only the code this engine actually
    // scored when `logicCode` came back with something. An implementation that turned out to be a
    // proxy itself, or that points at empty code, is an address the engine explicitly refused to
    // score — naming it as "the implementation it runs (…) is verified" next to a `privileges`
    // finding saying that code couldn't be identified is the report contradicting itself.
    guard("verified", () => checkVerified(input, contract, forwardsCalls ? { at: logicCode === null ? null : logicAt, info: logicContract } : null, arcosTemplate)),
    guard("ownership", () => checkOwnership(input, owner, found)).then(gate),
    guard("privileges", () => checkPrivileges(input, found, logicGap, owner)).then(gate),
    guard("proxy", () => {
      if (cloneOf === null && topSlotsError) throw topSlotsError;
      return checkProxy(input, { cloneOf, cloneReadFailed, cloneTargetEmpty, targetSlotsRead, forwardsToUnidentifiedCode, logicDelegates, upgradeable, admin });
    }),
    guard("holders", () => checkHolders(input, holderPage, supply, poolScan, tokenInfo?.holdersCount ?? null)),
    guard("liquidity", () => checkLiquidity(input, poolScan)),
    guard("lp-lock", () => checkLpLock(input, poolScan)),
    guard("prevrandao", () => checkPrevrandao(input, logicCode, logicGap)).then(gateOpcodes),
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
