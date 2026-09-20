import { extractSelectors, minimalProxyTarget } from "./bytecode";
import {
  checkHolders, checkLiquidity, checkLpLock, checkOwnership, checkPrevrandao, checkPrivileges, checkProxy,
  checkVerified, erc20Abi, findPools, resolveOwner,
} from "./checks";
import type { ContractInfo, Holder, TokenInfo } from "./explorer";
import type { CheckId, Finding, InspectInput, Report } from "./types";

export class NotAContract extends Error {
  constructor(address: string) {
    super(`${address} has no code`);
    this.name = "NotAContract";
  }
}

const ORDER: CheckId[] = ["verified", "ownership", "privileges", "proxy", "holders", "liquidity", "lp-lock", "prevrandao"];

/** A check that throws becomes an "unknown" finding; one bad RPC call never sinks the report. */
async function guard(id: CheckId, run: () => Finding | Promise<Finding>): Promise<Finding> {
  try {
    return await run();
  } catch (e) {
    return { id, status: "unknown", title: "This check couldn't run", detail: (e as Error).message.slice(0, 200), evidenceUrl: null, fixAppId: null };
  }
}

export async function inspect(input: InspectInput): Promise<Report> {
  const { reader, explorer, address } = input;
  const code = await reader.getCode(address);
  if (!code) throw new NotAContract(address);

  const cloneOf = minimalProxyTarget(code);
  const logicCode = (cloneOf && (await reader.getCode(cloneOf))) || code;
  const selectors = extractSelectors(logicCode);

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
    ask<Holder[]>(() => explorer!.topHolders(address)),
    resolveOwner(reader, address, selectors),
    findPools(input).catch(() => []),
    reader.blockNumber(),
  ]);

  const readOr = async <T>(fn: string, fallback: T): Promise<T> => (reader.read(address, erc20Abi, fn) as Promise<T>).catch(() => fallback);
  const [name, symbol, decimals, supply] = await Promise.all([
    readOr<string | null>("name", tokenInfo?.name ?? null),
    readOr<string | null>("symbol", tokenInfo?.symbol ?? null),
    readOr<number | null>("decimals", tokenInfo?.decimals ?? null),
    readOr<bigint | null>("totalSupply", tokenInfo?.totalSupply ? BigInt(tokenInfo.totalSupply) : null),
  ]);

  const findings = await Promise.all([
    guard("verified", () => checkVerified(input, contract ? contract.verified : null)),
    guard("ownership", () => checkOwnership(input, owner)),
    guard("privileges", () => checkPrivileges(input, logicCode, cloneOf ? null : (contract?.abi ?? null), owner)),
    guard("proxy", () => checkProxy(input, cloneOf)),
    guard("holders", () => checkHolders(input, holders, supply, pools)),
    guard("liquidity", () => checkLiquidity(input, pools)),
    guard("lp-lock", () => checkLpLock(input, pools)),
    guard("prevrandao", () => checkPrevrandao(input, logicCode)),
  ]);
  findings.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

  return {
    address,
    network: input.network,
    token: { name, symbol, decimals: decimals === null ? null : Number(decimals), totalSupply: supply === null ? null : supply.toString() },
    findings,
    passed: findings.filter((f) => f.status === "pass").length,
    total: findings.length,
    explorerReachable,
    blockNumber: blockNumber.toString(),
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}
