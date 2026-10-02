import { getAddress } from "viem";
import { tokenFactoryAbi, type Address } from "@arcos/chain";
import { extractSelectors, minimalProxyTarget, usesOpcode, type Hex } from "./bytecode";
import {
  ADMIN_SLOT, BEACON_SLOT, IMPL_SLOT, ZEPPELINOS_ADMIN_SLOT, ZEPPELINOS_IMPL_SLOT, abiDeclaresTransfer, addressFromSlot,
  beaconImplementation, checkHolders, checkLiquidity, checkLpLock, checkOwnership, checkPrevrandao, checkPrivileges,
  checkProxy, checkTrade, checkVerified, dispatcherInBytecode, erc20Abi, findPools, gateLogicPass, resolveOwner, slotReadable, slotSet,
  type LogicBlock, type LogicGap, type ProxySlotKind,
} from "./checks";
import { combinePrivileges, type Privilege } from "./privileges";
import { ExplorerUnavailable, type ContractInfo, type ExplorerSource, type HolderPage, type TokenInfo } from "./explorer";
import { cleanLabel } from "./label";
import { isDecodeFailure, isNodeAnswer } from "./rpc-errors";
import { CallReverted, type ChainReader, type CheckId, type Finding, type InspectInput, type Report } from "./types";

export class NotAContract extends Error {
  constructor(address: string) {
    super(`${address} has no code`);
    this.name = "NotAContract";
  }
}

const ORDER: CheckId[] = ["verified", "ownership", "privileges", "proxy", "holders", "liquidity", "lp-lock", "prevrandao", "trade"];
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

/** The slots a proxy can name its logic in, in the order they are read: EIP-1967's implementation and beacon slots,
 * then ZeppelinOS's implementation slot. */
const PROXY_SLOTS = [IMPL_SLOT, BEACON_SLOT, ZEPPELINOS_IMPL_SLOT] as const;

/** What one address's proxy slots hold. `read` is false when any of them couldn't be read. */
type ProxySlots = { read: boolean; impl: Address | null; beacon: Address | null; zeppelinos: Address | null };
const UNREAD: ProxySlots = { read: false, impl: null, beacon: null, zeppelinos: null };

/** Slot values read in `PROXY_SLOTS` order, every one of them `slotReadable`. */
const slotsFrom = (values: readonly (string | null)[]): ProxySlots => {
  const [impl = null, beacon = null, zeppelinos = null] = values.map(addressFromSlot);
  return { read: true, impl, beacon, zeppelinos };
};

/** Whose layout the set slots follow: EIP-1967's first, then ZeppelinOS's. `null` when none is set. */
const kindOf = (s: ProxySlots): ProxySlotKind | null => (s.impl || s.beacon ? "eip1967" : s.zeppelinos ? "zeppelinos" : null);

/** Both kinds of slot are set, so both kinds of admin slot may name someone. */
const bothKinds = (s: ProxySlots): boolean => s.zeppelinos !== null && (s.impl !== null || s.beacon !== null);

/** The ZeppelinOS slot names something other than what the EIP-1967 slots name: a beacon, or a different
 * implementation. Only the proxy's own bytecode decides which it reads, so neither is "the logic". */
const zeppelinosConflicts = (s: ProxySlots): boolean =>
  s.zeppelinos !== null && (s.beacon !== null || (s.impl !== null && s.impl.toLowerCase() !== s.zeppelinos.toLowerCase()));

/** Runs a call and tells `onFailure` when it rejects with an error `isFailure` accepts. The outcome passes through
 * unchanged: what a failed read means for a finding is still each check's own business. */
const watching =
  (isFailure: (e: unknown) => boolean, onFailure: () => void) =>
  async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      if (isFailure(e)) onFailure();
      throw e;
    }
  };

/** Reports every call that fails at the transport level. Not a failure: the contract answering (`CallReverted`), the
 * node rejecting the params (-32602), and viem failing to decode what the node answered. Asking again returns the
 * same in all three cases (see rpc-errors.ts). */
function watchReader(reader: ChainReader, onFailure: () => void): ChainReader {
  const watch = watching((e) => !(e instanceof CallReverted) && !isNodeAnswer(e) && !isDecodeFailure(e), onFailure);
  return {
    getCode: (address) => watch(() => reader.getCode(address)),
    getStorageAt: (address, slot) => watch(() => reader.getStorageAt(address, slot)),
    read: (address, abi, functionName, args, options) => watch(() => reader.read(address, abi, functionName, args, options)),
    blockNumber: () => watch(() => reader.blockNumber()),
    callWithOverride: (call, overrides) => watch(() => reader.callWithOverride(call, overrides)),
  };
}

/** Reports every request that ended in `ExplorerUnavailable`, including one a contract record absorbed and flagged
 * (`ContractInfo.degraded`). A 404 is the explorer answering, not an outage. */
function watchExplorer(explorer: ExplorerSource, onFailure: () => void): ExplorerSource {
  const watch = watching((e) => e instanceof ExplorerUnavailable, onFailure);
  return {
    contract: async (address) => {
      const info = await watch(() => explorer.contract(address));
      if (info.degraded) onFailure();
      return info;
    },
    token: (address) => watch(() => explorer.token(address)),
    topHolders: (address) => watch(() => explorer.topHolders(address)),
    tokenBalances: (address) => watch(() => explorer.tokenBalances(address)),
  };
}

export async function inspect(rawInput: InspectInput): Promise<Report> {
  // Every read the checks make goes through these two wrappers — `input.reader` and `input.explorer` are the only way
  // to the chain and the explorer — so no read, including one a check adds later, can fail without `degraded` hearing.
  let degraded = false;
  const markDegraded = () => {
    degraded = true;
  };
  // Checksum once so `Report.address` (and every evidence URL built from `input.address`) is
  // consistent regardless of the casing whoever triggered this inspection happened to pass in.
  const input: InspectInput = {
    ...rawInput,
    address: getAddress(rawInput.address),
    reader: watchReader(rawInput.reader, markDegraded),
    explorer: rawInput.explorer && watchExplorer(rawInput.explorer, markDegraded),
  };
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

  // Resolve what code actually runs, and what (if anything) this address's own proxy slots say.
  // These three outcomes are mutually exclusive:
  let topSlotsError: unknown = null;
  let topSlotsSet = false;
  let cloneTargetIsProxy = false;
  let targetSlotsRead = true;
  /** Whose layout the slots that make this upgradeable follow — this address's own, or the clone
   * target's. Picks the admin slot below and the proxy finding's wording. */
  let slotKind: ProxySlotKind | null = null;
  /** ...and whether those slots are of both kinds, so the ZeppelinOS admin slot has a say as well. */
  let slotsOfBothKinds = false;
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

  const readProxySlots = async (at: Address): Promise<ProxySlots> => {
    try {
      const values = await Promise.all(PROXY_SLOTS.map((slot) => reader.getStorageAt(at, slot)));
      // A malformed answer is no more an answer than a rejected call — see `slotReadable`.
      return values.every(slotReadable) ? slotsFrom(values) : UNREAD;
    } catch {
      return UNREAD;
    }
  };

  /**
   * One rule for every address the engine resolves as "the logic": it is only the logic if it
   * isn't a proxy in its own right. A TransparentUpgradeableProxy, most BeaconProxy builds and any
   * proxy with a function of its own all have a dispatcher, so "has no dispatcher" catches none of
   * them — its proxy slots and its clone shape do. One hop is all this engine follows, so a
   * second one is simply unidentified; and a slot that wouldn't read leaves "it isn't a proxy" as
   * an assumption, which is not something to score a report on.
   */
  const vet = (codeAt: string, slots: ProxySlots): LogicGap | null => {
    if (!slots.read) return "logic-unreadable";
    return minimalProxyTarget(codeAt) || slots.impl || slots.beacon || slots.zeppelinos ? "logic-unidentified" : null;
  };

  if (cloneOf === null) {
    const values = await Promise.all(PROXY_SLOTS.map((slot) => reader.getStorageAt(address, slot))).catch((e: unknown) => {
      topSlotsError = e;
      return null;
    });
    // A malformed answer is treated exactly like a read that threw: `checkProxy` rethrows it and
    // the logic block refuses to score this code (see `slotReadable`).
    if (values && !values.every(slotReadable)) topSlotsError = new Error("malformed storage answer");
    if (values && !topSlotsError) topSlotsSet = values.some(slotSet);
    if (topSlotsSet) {
      // A proxy's own bytecode is a trampoline with no function dispatcher: scoring it would
      // report "no privileged functions" about a token whose implementation can mint.
      const slots = slotsFrom(values!);
      slotKind = kindOf(slots);
      slotsOfBothKinds = bothKinds(slots);
      if ((slots.impl && slots.beacon) || zeppelinosConflicts(slots)) {
        // Nothing in the EVM resolves this: the proxy's OWN BYTECODE decides which slot it reads,
        // and a BeaconProxy with a stale or decoy implementation slot would be scored on code that
        // never runs. Two candidates is no candidate.
        logicCode = null;
        logicGap = "logic-ambiguous";
      } else {
        // EIP-1967 first, then ZeppelinOS. A beacon slot holds the BEACON's address, not the
        // logic's, so it needs its own call.
        logicAt = slots.impl ?? slots.zeppelinos ?? (await beaconImplementation(reader, slots.beacon));
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
    slotKind = kindOf(targetSlots);
    slotsOfBothKinds = bothKinds(targetSlots);
    cloneTargetIsProxy = slotKind !== null;
    if (!cloneTargetIsProxy) {
      // The target's slots have just been read, so `vet` only has the clone-of-a-clone shape (and
      // the unread-slot case) left to rule out.
      logicGap = vet(cloneImplCode!, targetSlots);
      logicCode = logicGap === null ? cloneImplCode : null;
      logicAt = cloneOf;
      logicVetted = true;
    } else if (zeppelinosConflicts(targetSlots)) {
      // Two candidates is no candidate, here as on a proxy of its own.
      logicCode = null;
      logicGap = "logic-ambiguous";
    } else {
      // One level of further resolution is enough — a proxy-of-a-proxy-of-a-proxy stays unknown.
      // EIP-1967 first, then ZeppelinOS. A beacon slot holds the BEACON's address, not the
      // logic's, so it needs its own call.
      const grandAddr = targetSlots.impl ?? targetSlots.zeppelinos ?? (await beaconImplementation(reader, targetSlots.beacon));
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
  // where the admin slot lives (the one of the same kind), and the page to link as evidence for
  // "someone can replace this".
  const upgradeableAt: Address | null = !upgradeable ? null : cloneOf === null ? address : cloneOf;
  // A failed admin read is not evidence of an empty slot, but it makes no difference to what can
  // be said: without an address, both are "whoever controls upgrades". With both kinds of slot set,
  // the ZeppelinOS admin slot has to agree with the EIP-1967 one, or be empty: if it names someone
  // else, or couldn't be read, which admin the proxy's bytecode honours can't be told, so nobody is
  // named (as `logic-ambiguous` scores no logic).
  const readAdmin = (slot: Hex): Promise<Address | null | undefined> =>
    reader.getStorageAt(upgradeableAt!, slot).then((v) => (slotReadable(v) ? addressFromSlot(v) : undefined), () => undefined);
  let admin: Address | null = null;
  if (upgradeableAt) {
    const [own, other] = await Promise.all([
      readAdmin(slotKind === "zeppelinos" ? ZEPPELINOS_ADMIN_SLOT : ADMIN_SLOT),
      slotsOfBothKinds ? readAdmin(ZEPPELINOS_ADMIN_SLOT) : Promise.resolve(null),
    ]);
    admin = own && (other === null || other?.toLowerCase() === own.toLowerCase()) ? own : null;
  }

  // Code that delegates calls but resolves to no known clone target or proxy slot. `checkProxy`
  // reports this shape on its own; what it must NOT do is discard the contract's own dispatcher,
  // whose privileged selectors are real evidence. Everything it can't vouch for is blocked by the
  // DELEGATECALL rule below instead — the same rule on every path.
  const forwardsToUnidentifiedCode = cloneOf === null && !topSlotsSet && usesOpcode(code, DELEGATECALL);
  /** The scored logic runs code from an address this engine never identified. Read by the `proxy`
   * check (a clone whose logic does this isn't "not replaceable" after all) and by the gate on the
   * three logic checks — one fact, one place. */
  const logicDelegates = logicCode !== null && usesOpcode(logicCode, DELEGATECALL);
  /** This token demonstrably runs code that isn't its own: a clone, or its proxy slots are set.
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
  // plain contract, and the resolved implementation's for anything that forwards (an EIP-1967 or
  // ZeppelinOS-style proxy, or an EIP-1167 clone) — never the forwarding contract's own.
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
      return checkProxy(input, { cloneOf, cloneReadFailed, cloneTargetEmpty, targetSlotsRead, forwardsToUnidentifiedCode, logicDelegates, upgradeable, slotKind, admin });
    }),
    guard("holders", () => checkHolders(input, holderPage, supply, poolScan, tokenInfo?.holdersCount ?? null)),
    guard("liquidity", () => checkLiquidity(input, poolScan)),
    guard("lp-lock", () => checkLpLock(input, poolScan)),
    guard("prevrandao", () => checkPrevrandao(input, logicCode, logicGap)).then(gateOpcodes),
    // Behaviour measured at this block, not a statement about the code, so no logic gate: what the code may do later is
    // the privileges and proxy findings' business.
    guard("trade", () => checkTrade(input, poolScan)),
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
    degraded,
    blockNumber: blockNumber === null ? "unknown" : blockNumber.toString(),
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}
