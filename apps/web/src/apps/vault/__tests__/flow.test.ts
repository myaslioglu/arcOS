import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { FEE_KEYS, lockVaultAbi, positionVaultAbi, vaultFactoryAbi } from "@arcos/chain";
import { INSUFFICIENT_FUNDS_ERROR } from "@/lib/contract-error";
import { POSITION_NFT_ABI } from "@/lib/positions";
import { LOCK_ABI, NOT_CONNECTED, WRONG_NETWORK } from "../errors";
import type { FeeAmounts } from "../fees";
import {
  ACTION_EVENT,
  FIND_EVERY_MS,
  FIND_TRIES,
  actionCall,
  actionHappened,
  approvalFor,
  collectedFromLogs,
  feeChange,
  findLocked,
  lockCall,
  lockedFromLogs,
  maxFeeBps,
  runAction,
  runLock,
  whyLockReverted,
  type ContractCall,
  type FlowClient,
  type FlowDeps,
  type LockPlan,
  type LockStep,
} from "../flow";

const CHAIN = 5042002;
const FACTORY = getAddress("0x2aa12f98795e7a65072950afba9d1e023d398241");
const CONTROLLER = getAddress("0x72f853e9e202600c5017b5a060168603c3ed7368");
const WALLET = getAddress("0x7e57000000000000000000000000000000000001");
const OTHER = getAddress("0x7e57000000000000000000000000000000000002");
const TOKEN = getAddress("0xbff22091be481b41c8ca49862653aba216bac041");
const TOKEN_B = getAddress("0xf4f40da2d2b7f0a2c5d2d3e113ddfbeb3ffdca5e");
const MANAGER = getAddress("0x6049c9a0e26405c0985f9e3685c87d0ae917f82b");
const VAULT = getAddress("0x011916e14b8399fec0109f3402d283c71250c33c");
const FAKE_VAULT = getAddress("0x00000000000000000000000000000000000ba5ed");
const FEE = 30n * 10n ** 18n;
const UNLOCK = 1_900_000_000;
/** The fees the form showed. */
const SHOWN: FeeAmounts = { flat: FEE, lpBps: 50n, shareBps: 200n };

/** A log as a receipt carries it, from `address`, for one of `abi`'s events. */
function eventLog(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>): Log {
  const item = abi.find((i) => i.type === "event" && i.name === eventName) as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const data = encodeAbiParameters(
    item.inputs.filter((i) => !i.indexed),
    item.inputs.filter((i) => !i.indexed).map((i) => args[i.name]),
  );
  return { address, topics, data, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false } as unknown as Log;
}
const tokenLocked = (address: Address, vault: Address, { owner = WALLET, token = TOKEN, amount = 1000n, fee = 0n, unlockAt = BigInt(UNLOCK) } = {}) =>
  eventLog(address, vaultFactoryAbi as Abi, "TokenLocked", { owner, token, vault, amount, fee, unlockAt });
const positionLocked = (address: Address, vault: Address, tokenId = 7n, unlockAt = BigInt(UNLOCK)) =>
  eventLog(address, vaultFactoryAbi as Abi, "PositionLocked", { owner: WALLET, manager: MANAGER, tokenId, vault, unlockAt });

/** A factory event as getContractEvents decodes it. */
type FactoryEvent = { transactionHash: Hex; args: Record<string, unknown> };
const tokenEvent = (vault: Address, hash: Hex, over: Record<string, unknown> = {}): FactoryEvent => ({
  transactionHash: hash,
  args: { owner: WALLET, token: TOKEN, vault, amount: 1000n, fee: 0n, unlockAt: BigInt(UNLOCK), ...over },
});

type Chain = {
  allowance?: bigint;
  /** The allowance once the approval has been sent: the amount approved, unless a test says otherwise. */
  allowanceAfterApprove?: bigint;
  approved?: Address;
  operator?: boolean;
  /** The fees the FeeController holds, and what it holds once the approval has been sent. */
  fees?: Partial<FeeAmounts>;
  feesAfterApprove?: Partial<FeeAmounts>;
  /** The wallet's registry: its length before the lock, the vaults the lock added, and how many looks miss them. */
  registry?: { before: bigint; added: Address[]; late?: number };
  /** What each vault holds, for findLocked: a token, or a manager and an id, and its unlock time. */
  vaults?: Record<string, { token?: Address; manager?: Address; tokenId?: bigint; unlockAt?: bigint }>;
  events?: FactoryEvent[];
  /** What each function's receipt is: a status and logs, or "lost" for one that can't be read. */
  receipts?: Record<string, { status: "success" | "reverted"; logs: Log[]; to?: Address; blockNumber?: bigint } | "lost">;
  /** Errors the simulation or the wallet throws, by function name. */
  simulate?: Record<string, unknown>;
  /** Errors a simulation at a past block (a mined lock asked why it reverted) throws, by function name. */
  replay?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
};

/** Errors a wallet answers before it sends anything, as viem and wagmi name them. */
const PRE_SEND = new Set(["UserRejectedRequestError", "ChainMismatchError", "ConnectorNotConnectedError", "InsufficientFundsError"]);

function fake(c: Chain = {}) {
  const sent: Array<ContractCall & { chainId?: number; value?: bigint; account?: Address }> = [];
  let approvalSent = false;
  let lockSent = false;
  let looks = 0;
  const client: FlowClient = {
    readContract: vi.fn(async ({ address, functionName, args }: ContractCall) => {
      if (functionName === "feeController") return CONTROLLER;
      if (functionName === "feeOf") {
        const fees = { ...SHOWN, ...c.fees, ...(approvalSent ? c.feesAfterApprove : {}) };
        const key = (args as Hex[])[0];
        return key === FEE_KEYS.LOCK_FLAT ? fees.flat : key === FEE_KEYS.LOCK_LP_BPS ? fees.lpBps : key === FEE_KEYS.LOCK_FEE_SHARE_BPS ? fees.shareBps : 0n;
      }
      if (functionName === "allowance") return approvalSent ? (c.allowanceAfterApprove ?? 10n ** 30n) : (c.allowance ?? 0n);
      if (functionName === "getApproved") return approvalSent ? FACTORY : (c.approved ?? zeroAddress);
      if (functionName === "isApprovedForAll") return c.operator ?? false;
      const shown = lockSent && looks > (c.registry?.late ?? 0);
      if (functionName === "vaultsOfLength") {
        if (lockSent) looks += 1;
        return (c.registry?.before ?? 0n) + (lockSent && looks > (c.registry?.late ?? 0) ? BigInt(c.registry?.added.length ?? 0) : 0n);
      }
      if (functionName === "vaultsOfSlice") return shown ? (c.registry?.added ?? []) : [];
      const v = c.vaults?.[address.toLowerCase()];
      if (functionName === "token" && v?.token) return v.token;
      if (functionName === "manager" && v?.manager) return v.manager;
      if (functionName === "tokenId" && v?.tokenId !== undefined) return v.tokenId;
      if (functionName === "unlockAt" && v) return v.unlockAt ?? BigInt(UNLOCK);
      throw new Error(`unexpected read ${functionName}`);
    }),
    getBlockNumber: vi.fn(async () => 1_000n),
    getContractEvents: vi.fn(async () => (c.events ?? []) as never),
    simulateContract: vi.fn(async (args) => {
      if (args.blockNumber !== undefined) {
        if (c.replay?.[args.functionName]) throw c.replay[args.functionName];
        return { request: { ...args } };
      }
      if (c.simulate?.[args.functionName]) throw c.simulate[args.functionName];
      return { request: { ...args } };
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const fn = hash.slice(2);
      const receipt = c.receipts?.[fn] ?? { status: "success", logs: [] };
      if (receipt === "lost") throw new Error("timeout");
      return receipt;
    }),
  };
  const writeContractAsync = vi.fn(async (request: never) => {
    const r = request as ContractCall & { chainId?: number };
    const error = c.wallet?.[r.functionName];
    // A refusal, or an error that stops the wallet before it sends, sends nothing; any other error here stands for a
    // reply lost after the transaction went out.
    if (error && PRE_SEND.has((error as { name?: string }).name ?? "")) throw error;
    if (r.functionName === "approve") approvalSent = true;
    if (r.functionName.startsWith("lock")) lockSent = true;
    if (error) throw error;
    sent.push(r);
    // The hash names the function, so a receipt can be picked per call.
    return `0x${r.functionName}` as Hex;
  });
  const wait = vi.fn(async () => undefined);
  const deps: FlowDeps = { client, account: WALLET, chainId: CHAIN, walletChainId: CHAIN, writeContractAsync, wait };
  return { deps, client, sent, writeContractAsync, wait };
}

const tokenPlan: LockPlan = { kind: "token", token: TOKEN, amount: 1000n, unlockAt: UNLOCK, pair: false };
const lpPlan: LockPlan = { ...tokenPlan, pair: true };
const positionPlan: LockPlan = { kind: "position", manager: MANAGER, tokenId: 7n, unlockAt: UNLOCK };
const named = (name: string, message = "x") => Object.assign(new Error(message), { name });
const rejected = named("UserRejectedRequestError", "User rejected the request.");
const lost = Object.assign(new Error("Request expired"), { code: -32603 });

describe("runLock: a token", () => {
  it("approves exactly the amount, then locks it for the wallet with the fee as value, every write pinned to the chain", async () => {
    const f = fake({ receipts: { lockToken: { status: "success", logs: [tokenLocked(FACTORY, VAULT, { amount: 995n })] } } });
    const steps: Array<[LockStep, boolean]> = [];
    const outcome = await runLock(tokenPlan, FACTORY, SHOWN, f.deps, (step, sent) => steps.push([step, sent]));
    // What reached the vault comes from the factory's event.
    expect(outcome).toEqual({ result: "locked", vault: VAULT, hash: "0xlockToken", amount: 995n });
    expect(f.sent.map((s) => [s.functionName, s.address, s.args, s.value, s.chainId])).toEqual([
      ["approve", TOKEN, [FACTORY, 1000n], undefined, CHAIN],
      // Not a pair: it accepts no share at all.
      ["lockToken", FACTORY, [TOKEN, 1000n, BigInt(UNLOCK), WALLET, 0n], FEE, CHAIN],
    ]);
    expect(f.sent[0]?.abi).toBe(erc20Abi);
    expect(f.sent[1]?.abi).toBe(LOCK_ABI);
    expect(steps).toEqual([
      ["approve", false],
      ["approve", true],
      ["lock", false],
      ["lock", true],
    ]);
  });

  it("skips the approval when the factory may already take the amount", async () => {
    const f = fake({ allowance: 1000n, receipts: { lockToken: { status: "success", logs: [tokenLocked(FACTORY, VAULT)] } } });
    expect((await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).result).toBe("locked");
    expect(f.sent.map((s) => s.functionName)).toEqual(["lockToken"]);
  });

  it("reads the lock from the factory's own event for this owner, token and unlock time, never from a forged one", async () => {
    const logs = [
      tokenLocked(TOKEN, FAKE_VAULT),
      tokenLocked(FACTORY, FAKE_VAULT, { owner: OTHER }),
      tokenLocked(FACTORY, FAKE_VAULT, { token: TOKEN_B }),
      tokenLocked(FACTORY, FAKE_VAULT, { unlockAt: BigInt(UNLOCK + 1) }),
      tokenLocked(FACTORY, VAULT, { amount: 990n }),
    ];
    expect(lockedFromLogs(logs, FACTORY, tokenPlan, WALLET)).toEqual({ vault: VAULT, amount: 990n });
    expect(lockedFromLogs(logs.slice(0, 4), FACTORY, tokenPlan, WALLET)).toBeNull();
  });

  it("refuses a wallet on another network before reading or sending anything", async () => {
    const f = fake();
    const outcome = await runLock(tokenPlan, FACTORY, SHOWN, { ...f.deps, walletChainId: 1 });
    expect(outcome).toMatchObject({ result: "failed", message: "Your wallet is on a different network. Switch to Arc and try again." });
    expect(f.client.readContract).not.toHaveBeenCalled();
  });

  it("says a refused approval plainly, with nothing left behind", async () => {
    const f = fake({ wallet: { approve: rejected } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toEqual({ result: "failed", message: "You cancelled the request in your wallet.", approvalLeft: false });
  });

  it("says when the approval it gave is still in place because the lock was refused", async () => {
    const f = fake({ wallet: { lockToken: rejected } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toEqual({ result: "failed", message: "You cancelled the request in your wallet.", approvalLeft: true });
  });

  it("stops on an approval that reverted, and on a lock that reverted (the fee comes back with it)", async () => {
    const approval = fake({ receipts: { approve: { status: "reverted", logs: [] } } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, approval.deps)).toEqual({
      result: "failed",
      message: "The approval reverted, so nothing was locked.",
      hash: "0xapprove",
      approvalLeft: false,
    });
    expect(approval.sent.map((s) => s.functionName)).toEqual(["approve"]);
    const lock = fake({ receipts: { lockToken: { status: "reverted", logs: [] } } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, lock.deps)).toEqual({
      result: "failed",
      message: "The lock reverted. Nothing was locked, and the fee wasn't taken.",
      hash: "0xlockToken",
      approvalLeft: true,
    });
  });

  it("never calls a sent lock failed when its outcome is unknown: no receipt, or no vault reported", async () => {
    const receiptLost = fake({ receipts: { lockToken: "lost" } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, receiptLost.deps)).toEqual({
      result: "unconfirmed",
      message: "The lock was sent, but it isn't confirmed yet. Check the explorer before you lock again.",
      hash: "0xlockToken",
    });
    const silent = fake();
    expect(await runLock(tokenPlan, FACTORY, SHOWN, silent.deps)).toMatchObject({ result: "unconfirmed", hash: "0xlockToken" });
    const approvalLost = fake({ receipts: { approve: "lost" } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, approvalLost.deps)).toMatchObject({ result: "unconfirmed", hash: "0xapprove" });
    expect(approvalLost.sent.map((s) => s.functionName)).toEqual(["approve"]);
  });

  it("turns a simulated revert into the vault's sentence before the wallet opens", async () => {
    const data = encodeErrorResult({ abi: lockVaultAbi, errorName: "BadUnlockTime" });
    const f = fake({ allowance: 10n ** 30n, simulate: { lockToken: new ContractFunctionRevertedError({ abi: LOCK_ABI as Abi, data, functionName: "lockToken" }) } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toMatchObject({
      result: "failed",
      message: "The unlock date must be in the future, at most 10 years from now, and later than the current one.",
    });
    expect(f.writeContractAsync).not.toHaveBeenCalled();
  });
});

describe("runLock: the fees it charges are the ones the form showed", () => {
  it("stops before the wallet opens when the flat fee changed", async () => {
    const f = fake({ fees: { flat: 31n * 10n ** 18n } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toEqual({
      result: "failed",
      message: "The lock fee changed to 31 USDC. Check it and lock again.",
      approvalLeft: false,
    });
    expect(f.writeContractAsync).not.toHaveBeenCalled();
  });

  it("stops an LP token's lock when the LP share changed, and a position's when the share of collected fees did", async () => {
    const lp = fake({ fees: { lpBps: 100n } });
    expect(await runLock(lpPlan, FACTORY, SHOWN, lp.deps)).toMatchObject({ result: "failed", message: "ArcOS's share of an LP token lock changed to 1%. Check it and lock again." });
    expect(lp.writeContractAsync).not.toHaveBeenCalled();
    const position = fake({ fees: { shareBps: 500n } });
    expect(await runLock(positionPlan, FACTORY, SHOWN, position.deps)).toMatchObject({
      result: "failed",
      message: "ArcOS's share of collected fees changed to 5%. Check it and lock again.",
    });
    expect(position.writeContractAsync).not.toHaveBeenCalled();
  });

  it("reads them again right before the lock: a raise applied while the approval was signed stops it", async () => {
    const f = fake({ feesAfterApprove: { lpBps: 100n } });
    expect(await runLock(lpPlan, FACTORY, SHOWN, f.deps)).toEqual({
      result: "failed",
      message: "ArcOS's share of an LP token lock changed to 1%. Check it and lock again.",
      approvalLeft: true,
    });
    expect(f.sent.map((s) => s.functionName)).toEqual(["approve"]);
  });

  it("minds only the fees this lock pays", () => {
    const now = { flat: FEE, lpBps: 100n, shareBps: 500n };
    expect(feeChange(tokenPlan, SHOWN, now)).toBeNull();
    expect(feeChange(lpPlan, SHOWN, { ...now, shareBps: SHOWN.shareBps })?.message).toMatch(/LP token lock changed to 1%/);
    expect(feeChange(positionPlan, SHOWN, { ...now, lpBps: SHOWN.lpBps })?.message).toMatch(/collected fees changed to 5%/);
    expect(feeChange(lpPlan, SHOWN, SHOWN)).toBeNull();
  });
});

describe("runLock: a share raised above the one the form showed (FeeAboveMax)", () => {
  /** FeeAboveMax as viem hands it over, decoded with the lock's ABI. */
  const feeAboveMax = (key: Hex, current: bigint, max: bigint, functionName: string) =>
    new ContractFunctionRevertedError({
      abi: LOCK_ABI as Abi,
      data: encodeErrorResult({ abi: vaultFactoryAbi, errorName: "FeeAboveMax", args: [key, current, max] }),
      functionName,
    });
  const LP_ROSE = "ArcOS's share of an LP token lock rose to 1%, above the 0.5% this lock accepted. Nothing was locked and no fee was taken. Check it and lock again.";
  const SHARE_ROSE =
    "ArcOS's share of collected fees rose to 5%, above the 2% this lock accepted. Nothing was locked and no fee was taken. Check it and lock again.";

  it("sends an LP token's lock with the LP share the form showed", async () => {
    const f = fake({ receipts: { lockToken: { status: "success", logs: [tokenLocked(FACTORY, VAULT, { amount: 995n, fee: 5n })] } } });
    expect((await runLock(lpPlan, FACTORY, SHOWN, f.deps)).result).toBe("locked");
    expect(f.sent.at(-1)?.args).toEqual([TOKEN, 1000n, BigInt(UNLOCK), WALLET, 50n]);
  });

  it("says a raise the simulation meets in so many words, before the wallet opens, with the approval it gave still set", async () => {
    const f = fake({ simulate: { lockToken: feeAboveMax(FEE_KEYS.LOCK_LP_BPS, 100n, 50n, "lockToken") } });
    expect(await runLock(lpPlan, FACTORY, SHOWN, f.deps)).toEqual({ result: "failed", message: LP_ROSE, approvalLeft: true });
    expect(f.sent.map((s) => s.functionName)).toEqual(["approve"]);
  });

  it("names a lock that reverted on chain by asking again at its block: a raise applied just before it was mined", async () => {
    const f = fake({
      receipts: { lockPosition: { status: "reverted", logs: [], blockNumber: 1_234n } },
      replay: { lockPosition: feeAboveMax(FEE_KEYS.LOCK_FEE_SHARE_BPS, 500n, 200n, "lockPosition") },
    });
    expect(await runLock(positionPlan, FACTORY, SHOWN, f.deps)).toEqual({ result: "failed", message: SHARE_ROSE, hash: "0xlockPosition", approvalLeft: true });
    // The same call, the same fee and maximum, on the state the lock's block left.
    expect(f.client.simulateContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "lockPosition", args: [MANAGER, 7n, BigInt(UNLOCK), WALLET, 200n], value: FEE, account: WALLET, blockNumber: 1_234n }),
    );
  });

  it("keeps the plain sentence when the question can't be asked or answered: no block, a call that goes through now, an error it can't name", async () => {
    const plain = "The lock reverted. Nothing was locked, and the fee wasn't taken.";
    const noBlock = fake({ receipts: { lockToken: { status: "reverted", logs: [] } } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, noBlock.deps)).toMatchObject({ result: "failed", message: plain });
    const passesNow = fake({ receipts: { lockToken: { status: "reverted", logs: [], blockNumber: 9n } } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, passesNow.deps)).toMatchObject({ result: "failed", message: plain });
    const unknown = fake({ receipts: { lockToken: { status: "reverted", logs: [], blockNumber: 9n } }, replay: { lockToken: new Error("rpc down") } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, unknown.deps)).toMatchObject({ result: "failed", message: plain });
    const poor = fake({ receipts: { lockToken: { status: "reverted", logs: [], blockNumber: 9n } }, replay: { lockToken: named("InsufficientFundsError") } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, poor.deps)).toMatchObject({ result: "failed", message: plain });
    expect(await whyLockReverted(passesNow.client, { ...lockCall(tokenPlan, FACTORY, WALLET, SHOWN), account: WALLET, value: FEE }, undefined)).toBe(plain);
  });

  it("calls the wallet's own gas estimate meeting the raise a plain failure in the same words", async () => {
    const reverted = {
      name: "ContractFunctionExecutionError",
      cause: { name: "ContractFunctionRevertedError", raw: "0x1234", data: { errorName: "FeeAboveMax", args: [FEE_KEYS.LOCK_LP_BPS, 100n, 50n] } },
    };
    const f = fake({ wallet: { lockToken: reverted } });
    expect(await runLock(lpPlan, FACTORY, SHOWN, f.deps)).toEqual({ result: "failed", message: LP_ROSE, approvalLeft: true });
    expect(f.client.getContractEvents).not.toHaveBeenCalled();
  });
});

describe("runLock: after a wallet error that isn't a refusal, the chain decides", () => {
  const found = (over: Chain = {}) =>
    fake({
      registry: { before: 3n, added: [FAKE_VAULT, VAULT] },
      vaults: { [FAKE_VAULT.toLowerCase()]: { token: TOKEN_B }, [VAULT.toLowerCase()]: { token: TOKEN } },
      events: [tokenEvent(FAKE_VAULT, "0xother", { token: TOKEN_B }), tokenEvent(VAULT, "0xfound", { amount: 995n, fee: 5n })],
      wallet: { lockToken: lost },
      ...over,
    });

  it("finds the lock in the registry, with its transaction and what reached the vault", async () => {
    const f = found();
    const steps: LockStep[] = [];
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps, (s) => steps.push(s))).toEqual({ result: "locked", vault: VAULT, hash: "0xfound", amount: 995n });
    expect(steps.at(-1)).toBe("find");
    expect(f.client.getContractEvents).toHaveBeenCalledWith(expect.objectContaining({ address: FACTORY, eventName: "TokenLocked", args: { owner: WALLET }, fromBlock: 1_000n }));
  });

  it("looks again for about a minute while the transaction is mined", async () => {
    const f = found({ registry: { before: 3n, added: [VAULT], late: 4 } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toMatchObject({ result: "locked", vault: VAULT });
    expect(f.wait).toHaveBeenCalledTimes(4);
    expect(f.wait).toHaveBeenCalledWith(FIND_EVERY_MS);
    expect(FIND_TRIES * FIND_EVERY_MS).toBeGreaterThanOrEqual(55_000);
  });

  it("calls the outcome unknown, never failed, when no lock shows up: no blind second lock", async () => {
    const f = fake({ registry: { before: 2n, added: [] }, wallet: { lockToken: lost } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toEqual({
      result: "unconfirmed",
      message: "Your wallet answered with an error, and no new lock showed up on chain within a minute. Check Your locks before you lock again.",
    });
    expect(f.wait).toHaveBeenCalledTimes(FIND_TRIES - 1);
    // The approval and the one lock: nothing is sent again.
    expect(f.writeContractAsync).toHaveBeenCalledTimes(2);
  });

  it("never takes someone else's lock for the wallet for this one: another amount, another unlock time, another token", async () => {
    for (const over of [{ amount: 999n }, { unlockAt: BigInt(UNLOCK + 60) }, { token: TOKEN_B }]) {
      const f = found({ events: [tokenEvent(VAULT, "0xtheirs", over)] });
      expect((await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).result, JSON.stringify(over, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toBe("unconfirmed");
    }
    // The vault itself must say so too.
    const moved = found({ vaults: { [VAULT.toLowerCase()]: { token: TOKEN, unlockAt: BigInt(UNLOCK + 60) } } });
    expect((await runLock(tokenPlan, FACTORY, SHOWN, moved.deps)).result).toBe("unconfirmed");
    // Without the factory's event there is no telling whose it is.
    const unseen = found({ events: [] });
    expect((await runLock(tokenPlan, FACTORY, SHOWN, unseen.deps)).result).toBe("unconfirmed");
  });

  it("finds a position's lock by its manager, id and unlock time", async () => {
    const f = fake({
      registry: { before: 0n, added: [VAULT] },
      vaults: { [VAULT.toLowerCase()]: { manager: MANAGER, tokenId: 7n } },
      events: [{ transactionHash: "0xpos", args: { owner: WALLET, manager: MANAGER, tokenId: 7n, vault: VAULT, unlockAt: BigInt(UNLOCK) } }],
      wallet: { lockPosition: lost },
    });
    expect(await runLock(positionPlan, FACTORY, SHOWN, f.deps)).toEqual({ result: "locked", vault: VAULT, hash: "0xpos" });
    const other = fake({
      registry: { before: 0n, added: [VAULT] },
      vaults: { [VAULT.toLowerCase()]: { manager: MANAGER, tokenId: 8n } },
      events: [{ transactionHash: "0xpos", args: { owner: WALLET, manager: MANAGER, tokenId: 8n, vault: VAULT, unlockAt: BigInt(UNLOCK) } }],
      wallet: { lockPosition: lost },
    });
    expect((await runLock(positionPlan, FACTORY, SHOWN, other.deps)).result).toBe("unconfirmed");
  });

  it("says nothing is found when the registry can't be read", async () => {
    const f = fake();
    (f.client.readContract as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"));
    expect(await findLocked(f.client, FACTORY, tokenPlan, WALLET, 0n, 1n)).toBeNull();
  });

  it("looks for the lock after a wallet's -32603, which viem's writeContract turns into a revert without data", async () => {
    const asViemDoes = { name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError", reason: "An internal error was received.", cause: lost } };
    const f = found({ wallet: { lockToken: asViemDoes } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toMatchObject({ result: "locked", vault: VAULT, hash: "0xfound" });
  });

  it("calls the wallet's own gas estimate reverting, with the revert's data, a plain failure in the contract's words", async () => {
    const reverted = {
      name: "ContractFunctionExecutionError",
      cause: { name: "ContractFunctionRevertedError", raw: "0x5e2be5c1", data: { errorName: "WrongFee", args: [31n * 10n ** 18n, FEE] } },
    };
    const f = found({ wallet: { lockToken: reverted } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toMatchObject({ result: "failed", message: "The lock fee changed while you were signing. It is now 31 USDC. Check it and lock again." });
    expect(f.client.getContractEvents).not.toHaveBeenCalled();
  });

  it("calls an error that shows nothing was sent a plain failure, and looks for nothing", async () => {
    const cases: Array<[unknown, string]> = [
      [named("ChainMismatchError"), WRONG_NETWORK],
      [named("ConnectorNotConnectedError"), NOT_CONNECTED],
      [named("InsufficientFundsError"), INSUFFICIENT_FUNDS_ERROR],
    ];
    for (const [error, message] of cases) {
      const f = fake({ allowance: 10n ** 30n, wallet: { lockToken: error } });
      expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toEqual({ result: "failed", message, approvalLeft: false });
      expect(f.client.getContractEvents).not.toHaveBeenCalled();
      expect(f.wait).not.toHaveBeenCalled();
    }
  });

  it("goes on to the lock when an approval's wallet error came after it was set, and stops when it wasn't", async () => {
    const set = fake({ wallet: { approve: lost }, receipts: { lockToken: { status: "success", logs: [tokenLocked(FACTORY, VAULT)] } } });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, set.deps)).toEqual({ result: "locked", vault: VAULT, hash: "0xlockToken", amount: 1000n });
    const notSet = fake({ wallet: { approve: lost }, allowanceAfterApprove: 0n });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, notSet.deps)).toMatchObject({ result: "failed", approvalLeft: false });
    expect(notSet.sent).toEqual([]);
  });

  it("reads the allowance again after a successful approval receipt: a cancelled approval stops before the lock", async () => {
    const f = fake({ allowanceAfterApprove: 999n });
    expect(await runLock(tokenPlan, FACTORY, SHOWN, f.deps)).toEqual({
      result: "failed",
      message: "The approval didn't take effect, so nothing was locked. Try again.",
      hash: "0xapprove",
      approvalLeft: false,
    });
    expect(f.sent.map((x) => x.functionName)).toEqual(["approve"]);
  });
});

describe("runLock: a position", () => {
  it("approves the factory for this one position, then locks it", async () => {
    const f = fake({ receipts: { lockPosition: { status: "success", logs: [positionLocked(FACTORY, VAULT)] } } });
    expect(await runLock(positionPlan, FACTORY, SHOWN, f.deps)).toEqual({ result: "locked", vault: VAULT, hash: "0xlockPosition" });
    expect(f.sent.map((s) => [s.functionName, s.address, s.args, s.value])).toEqual([
      ["approve", MANAGER, [FACTORY, 7n], undefined],
      // At most the share of collected fees the form showed, which the vault keeps for life.
      ["lockPosition", FACTORY, [MANAGER, 7n, BigInt(UNLOCK), WALLET, 200n], FEE],
    ]);
    expect(f.sent[0]?.abi).toBe(POSITION_NFT_ABI);
  });

  it("skips the approval when the factory is already approved for it, or is an operator", async () => {
    for (const chain of [{ approved: FACTORY }, { operator: true }]) {
      const f = fake({ ...chain, receipts: { lockPosition: { status: "success", logs: [positionLocked(FACTORY, VAULT)] } } });
      expect((await runLock(positionPlan, FACTORY, SHOWN, f.deps)).result).toBe("locked");
      expect(f.sent.map((s) => s.functionName)).toEqual(["lockPosition"]);
    }
  });

  it("reads a position's vault from PositionLocked for this manager, id and unlock time only", () => {
    expect(lockedFromLogs([positionLocked(FACTORY, FAKE_VAULT, 8n), positionLocked(FACTORY, VAULT)], FACTORY, positionPlan, WALLET)).toEqual({ vault: VAULT });
    expect(lockedFromLogs([positionLocked(FACTORY, FAKE_VAULT, 8n), positionLocked(FACTORY, FAKE_VAULT, 7n, 1n)], FACTORY, positionPlan, WALLET)).toBeNull();
  });
});

describe("the calls themselves", () => {
  it("asks for the exact approval only when what is set falls short", async () => {
    const read = (allowance: bigint) => ({ readContract: async () => allowance }) as Pick<FlowClient, "readContract">;
    expect(await approvalFor(tokenPlan, FACTORY, WALLET, read(999n))).toMatchObject({ functionName: "approve", args: [FACTORY, 1000n] });
    expect(await approvalFor(tokenPlan, FACTORY, WALLET, read(1000n))).toBeNull();
  });

  it("locks for the wallet itself", () => {
    expect(lockCall(tokenPlan, FACTORY, WALLET, SHOWN).args?.[3]).toBe(WALLET);
    expect(lockCall(positionPlan, FACTORY, WALLET, SHOWN).args?.[3]).toBe(WALLET);
  });

  it("accepts at most the share the form showed: the LP share for a pair, the collect share for a position, none for any other token", () => {
    const shown = { flat: FEE, lpBps: 75n, shareBps: 250n };
    expect(maxFeeBps(lpPlan, shown)).toBe(75n);
    expect(maxFeeBps(positionPlan, shown)).toBe(250n);
    expect(maxFeeBps(tokenPlan, shown)).toBe(0n);
    expect(lockCall(lpPlan, FACTORY, WALLET, shown).args).toEqual([TOKEN, 1000n, BigInt(UNLOCK), WALLET, 75n]);
    expect(lockCall(positionPlan, FACTORY, WALLET, shown).args).toEqual([MANAGER, 7n, BigInt(UNLOCK), WALLET, 250n]);
    expect(lockCall(tokenPlan, FACTORY, WALLET, shown).args).toEqual([TOKEN, 1000n, BigInt(UNLOCK), WALLET, 0n]);
  });

  it("makes each action's call on the vault's own ABI, withdraws to the wallet, and cancels a handover to no one", () => {
    const token = { vault: VAULT, kind: "token" as const };
    const position = { vault: VAULT, kind: "position" as const };
    expect(actionCall(token, { kind: "extend", unlockAt: UNLOCK }, WALLET)).toEqual({ address: VAULT, abi: lockVaultAbi, functionName: "extend", args: [BigInt(UNLOCK)] });
    expect(actionCall(position, { kind: "collect" }, WALLET)).toEqual({ address: VAULT, abi: positionVaultAbi, functionName: "collect", args: [] });
    expect(actionCall(token, { kind: "withdraw" }, WALLET)).toMatchObject({ functionName: "withdraw", args: [WALLET] });
    expect(actionCall(position, { kind: "transfer", to: OTHER }, WALLET)).toMatchObject({ functionName: "transferOwnership", args: [OTHER] });
    expect(actionCall(position, { kind: "cancel" }, WALLET)).toMatchObject({ functionName: "transferOwnership", args: [zeroAddress] });
    expect(actionCall(token, { kind: "accept" }, WALLET)).toMatchObject({ functionName: "acceptOwnership", args: [] });
    expect(() => actionCall(token, { kind: "collect" }, WALLET)).toThrow("Only a position's vault collects fees.");
  });
});

describe("runAction", () => {
  const collected = (address: Address, currency: Address, toOwner: bigint, toPlatform: bigint) =>
    eventLog(address, positionVaultAbi as Abi, "Collected", { currency, toOwner, toPlatform });

  beforeEach(() => vi.restoreAllMocks());

  it("collects, and reports what the vault's own Collected events paid", async () => {
    const logs = [collected(VAULT, TOKEN, 98n, 2n), collected(VAULT, TOKEN_B, 49n, 1n), collected(FAKE_VAULT, TOKEN, 10n ** 30n, 0n)];
    const f = fake({ receipts: { collect: { status: "success", logs } } });
    const sent = vi.fn();
    expect(await runAction({ vault: VAULT, kind: "position" }, { kind: "collect" }, f.deps, sent)).toEqual({
      result: "done",
      hash: "0xcollect",
      collected: [
        { currency: TOKEN, toOwner: 98n, toPlatform: 2n },
        { currency: TOKEN_B, toOwner: 49n, toPlatform: 1n },
      ],
    });
    expect(sent).toHaveBeenCalledOnce();
    expect(f.sent[0]?.chainId).toBe(CHAIN);
    expect(collectedFromLogs([], VAULT)).toEqual([]);
  });

  /** The event an action's vault emits for it, from `from`, with `args`. */
  const eventFor = (kind: "extend" | "withdraw" | "transfer" | "cancel" | "accept", from: Address = VAULT, args: Record<string, unknown> = {}) =>
    kind === "extend"
      ? eventLog(from, lockVaultAbi as Abi, "Extended", { unlockAt: BigInt(UNLOCK), ...args })
      : kind === "withdraw"
        ? eventLog(from, lockVaultAbi as Abi, "Withdrawn", { to: WALLET, amount: 1n, ...args })
        : kind === "transfer"
          ? eventLog(from, lockVaultAbi as Abi, "OwnershipTransferStarted", { from: WALLET, to: OTHER, ...args })
          : kind === "cancel"
            ? eventLog(from, lockVaultAbi as Abi, "OwnershipTransferStarted", { from: WALLET, to: zeroAddress, ...args })
            : eventLog(from, lockVaultAbi as Abi, "OwnershipTransferred", { from: OTHER, to: WALLET, ...args });
  const receiptFor = (kind: Parameters<typeof eventFor>[0], from: Address = VAULT, args: Record<string, unknown> = {}) => ({
    status: "success" as const,
    logs: [eventFor(kind, from, args)],
    to: VAULT,
  });
  const actions = [
    ["extend", { kind: "extend", unlockAt: UNLOCK }, "extend"],
    ["withdraw", { kind: "withdraw" }, "withdraw"],
    ["transfer", { kind: "transfer", to: OTHER }, "transferOwnership"],
    ["cancel", { kind: "cancel" }, "transferOwnership"],
    ["accept", { kind: "accept" }, "acceptOwnership"],
  ] as const;

  it("extends, withdraws, hands over, cancels a handover and accepts, each counting once the vault's event says what was asked", async () => {
    for (const [kind, action, fn] of actions) {
      const f = fake({ receipts: { [fn]: receiptFor(kind) } });
      expect((await runAction({ vault: VAULT, kind: "token" }, action, f.deps)).result, kind).toBe("done");
      expect(f.sent).toHaveLength(1);
    }
  });

  it("calls a successful receipt without the vault's event, or one for another contract, unconfirmed: a cancelled or replaced transaction", async () => {
    for (const [kind, action, fn] of actions) {
      const empty = fake({ receipts: { [fn]: { status: "success", logs: [], to: VAULT } } });
      expect(await runAction({ vault: VAULT, kind: "token" }, action, empty.deps), kind).toMatchObject({ result: "unconfirmed", hash: `0x${fn}` });
      const elsewhere = fake({ receipts: { [fn]: receiptFor(kind, FAKE_VAULT) } });
      expect((await runAction({ vault: VAULT, kind: "token" }, action, elsewhere.deps)).result, kind).toBe("unconfirmed");
    }
    const replaced = fake({ receipts: { collect: { status: "success", logs: [], to: WALLET } } });
    expect((await runAction({ vault: VAULT, kind: "position" }, { kind: "collect" }, replaced.deps)).result).toBe("unconfirmed");
    // A collect with nothing to collect emits nothing: its own receipt counts.
    const nothing = fake({ receipts: { collect: { status: "success", logs: [], to: VAULT } } });
    expect(await runAction({ vault: VAULT, kind: "position" }, { kind: "collect" }, nothing.deps)).toEqual({ result: "done", hash: "0xcollect", collected: [] });
    expect(ACTION_EVENT).toEqual({
      extend: "Extended",
      collect: null,
      withdraw: "Withdrawn",
      transfer: "OwnershipTransferStarted",
      cancel: "OwnershipTransferStarted",
      accept: "OwnershipTransferred",
    });
    expect(actionHappened({ status: "success", logs: [] }, { vault: VAULT, kind: "token" }, { kind: "collect" }, WALLET)).toBe(true);
  });

  it("counts an event only with the action's own arguments", () => {
    const vault = { vault: VAULT, kind: "token" as const };
    expect(actionHappened(receiptFor("extend", VAULT, { unlockAt: BigInt(UNLOCK + 1) }), vault, { kind: "extend", unlockAt: UNLOCK }, WALLET)).toBe(false);
    expect(actionHappened(receiptFor("withdraw", VAULT, { to: OTHER }), vault, { kind: "withdraw" }, WALLET)).toBe(false);
    expect(actionHappened(receiptFor("transfer", VAULT, { to: WALLET }), vault, { kind: "transfer", to: OTHER }, WALLET)).toBe(false);
    // A handover started is no cancel, and a cancel is no handover.
    expect(actionHappened(receiptFor("transfer"), vault, { kind: "cancel" }, WALLET)).toBe(false);
    expect(actionHappened(receiptFor("cancel"), vault, { kind: "transfer", to: OTHER }, WALLET)).toBe(false);
    expect(actionHappened(receiptFor("accept", VAULT, { to: OTHER }), vault, { kind: "accept" }, WALLET)).toBe(false);
  });

  it("never calls a wallet error after sending a failure: the vault is read again", async () => {
    expect(await runAction({ vault: VAULT, kind: "token" }, { kind: "withdraw" }, fake({ wallet: { withdraw: lost } }).deps)).toEqual({
      result: "unconfirmed",
      message: "Your wallet answered with an error, so the transaction may or may not have been sent. Check the vault before you try again.",
    });
  });

  it("calls an error that shows nothing was sent a plain failure", async () => {
    expect(await runAction({ vault: VAULT, kind: "token" }, { kind: "withdraw" }, fake({ wallet: { withdraw: named("ChainMismatchError") } }).deps)).toEqual({
      result: "failed",
      message: WRONG_NETWORK,
    });
  });

  it("says a refusal, a revert, an unknown outcome and a decoded error each its own way", async () => {
    expect(await runAction({ vault: VAULT, kind: "token" }, { kind: "withdraw" }, fake({ wallet: { withdraw: rejected } }).deps)).toEqual({
      result: "failed",
      message: "You cancelled the request in your wallet.",
    });
    expect(await runAction({ vault: VAULT, kind: "token" }, { kind: "withdraw" }, fake({ receipts: { withdraw: { status: "reverted", logs: [] } } }).deps)).toEqual({
      result: "failed",
      message: "The transaction reverted. The vault is unchanged.",
      hash: "0xwithdraw",
    });
    expect(await runAction({ vault: VAULT, kind: "token" }, { kind: "withdraw" }, fake({ receipts: { withdraw: "lost" } }).deps)).toMatchObject({
      result: "unconfirmed",
      hash: "0xwithdraw",
    });
    const data = encodeErrorResult({ abi: lockVaultAbi, errorName: "StillLocked", args: [BigInt(UNLOCK)] });
    const still = new ContractFunctionRevertedError({ abi: lockVaultAbi as Abi, data, functionName: "withdraw" });
    const outcome = await runAction({ vault: VAULT, kind: "token" }, { kind: "withdraw" }, fake({ simulate: { withdraw: still } }).deps);
    expect(outcome).toEqual({ result: "failed", message: "This vault is locked until 17 Mar 2030, 17:46 UTC." });
  });
});
