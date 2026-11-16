import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { FEE_KEYS, lockVaultAbi, positionVaultAbi, vaultFactoryAbi } from "@arcos/chain";
import { POSITION_NFT_ABI } from "@/lib/positions";
import { LOCK_ABI } from "../errors";
import {
  ACTION_EVENT,
  actionCall,
  actionHappened,
  approvalFor,
  collectedFromLogs,
  findLocked,
  lockCall,
  runAction,
  runLock,
  vaultFromLogs,
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
const tokenLocked = (address: Address, vault: Address, owner = WALLET, token = TOKEN) =>
  eventLog(address, vaultFactoryAbi as Abi, "TokenLocked", { owner, token, vault, amount: 1n, fee: 0n, unlockAt: BigInt(UNLOCK) });
const positionLocked = (address: Address, vault: Address, tokenId = 7n) =>
  eventLog(address, vaultFactoryAbi as Abi, "PositionLocked", { owner: WALLET, manager: MANAGER, tokenId, vault, unlockAt: BigInt(UNLOCK) });

type Chain = {
  allowance?: bigint;
  /** The allowance once the approval has been sent: the amount approved, unless a test says otherwise. */
  allowanceAfterApprove?: bigint;
  approved?: Address;
  operator?: boolean;
  fee?: bigint;
  /** The wallet's registry: its length before the lock, and the vaults the lock added. */
  registry?: { before: bigint; added: Address[] };
  /** What each vault holds, for findLocked: a token, or a manager and an id. */
  vaults?: Record<string, { token?: Address; manager?: Address; tokenId?: bigint }>;
  events?: Array<{ transactionHash: Hex; args: { vault: Address } }>;
  /** What each function's receipt is: a status and logs, or "lost" for one that can't be read. */
  receipts?: Record<string, { status: "success" | "reverted"; logs: Log[]; to?: Address } | "lost">;
  /** Errors the simulation or the wallet throws, by function name. */
  simulate?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
};

function fake(c: Chain = {}) {
  const sent: Array<ContractCall & { chainId?: number; value?: bigint; account?: Address }> = [];
  let approvalSent = false;
  let lockSent = false;
  const client: FlowClient = {
    readContract: vi.fn(async ({ address, functionName, args }: ContractCall) => {
      if (functionName === "feeController") return CONTROLLER;
      if (functionName === "feeOf") {
        expect(args).toEqual([FEE_KEYS.LOCK_FLAT]);
        return c.fee ?? FEE;
      }
      if (functionName === "allowance") return approvalSent ? (c.allowanceAfterApprove ?? 10n ** 30n) : (c.allowance ?? 0n);
      if (functionName === "getApproved") return approvalSent ? FACTORY : (c.approved ?? "0x0000000000000000000000000000000000000000");
      if (functionName === "isApprovedForAll") return c.operator ?? false;
      if (functionName === "vaultsOfLength") return (c.registry?.before ?? 0n) + (lockSent ? BigInt(c.registry?.added.length ?? 0) : 0n);
      if (functionName === "vaultsOfSlice") return lockSent ? (c.registry?.added ?? []) : [];
      const v = c.vaults?.[address.toLowerCase()];
      if (functionName === "token" && v?.token) return v.token;
      if (functionName === "manager" && v?.manager) return v.manager;
      if (functionName === "tokenId" && v?.tokenId !== undefined) return v.tokenId;
      throw new Error(`unexpected read ${functionName}`);
    }),
    getBlockNumber: vi.fn(async () => 1_000n),
    getContractEvents: vi.fn(async () => c.events ?? []),
    simulateContract: vi.fn(async (args) => {
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
    // A refusal sends nothing; any other error here stands for a reply lost after the transaction went out.
    if (error && (error as { name?: string }).name === "UserRejectedRequestError") throw error;
    if (r.functionName === "approve") approvalSent = true;
    if (r.functionName.startsWith("lock")) lockSent = true;
    if (error) throw error;
    sent.push(r);
    // The hash names the function, so a receipt can be picked per call.
    return `0x${r.functionName}` as Hex;
  });
  const deps: FlowDeps = { client, account: WALLET, chainId: CHAIN, walletChainId: CHAIN, writeContractAsync };
  return { deps, client, sent, writeContractAsync };
}

const tokenPlan: LockPlan = { kind: "token", token: TOKEN, amount: 1000n, unlockAt: UNLOCK };
const positionPlan: LockPlan = { kind: "position", manager: MANAGER, tokenId: 7n, unlockAt: UNLOCK };
const rejected = Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });

describe("runLock: a token", () => {
  it("approves exactly the amount, then locks it for the wallet with the fee as value, every write pinned to the chain", async () => {
    const f = fake({ receipts: { lockToken: { status: "success", logs: [tokenLocked(FACTORY, VAULT)] } } });
    const steps: Array<[LockStep, boolean]> = [];
    const outcome = await runLock(tokenPlan, FACTORY, FEE, f.deps, (step, sent) => steps.push([step, sent]));
    expect(outcome).toEqual({ result: "locked", vault: VAULT, hash: "0xlockToken" });
    expect(f.sent.map((s) => [s.functionName, s.address, s.args, s.value, s.chainId])).toEqual([
      ["approve", TOKEN, [FACTORY, 1000n], undefined, CHAIN],
      ["lockToken", FACTORY, [TOKEN, 1000n, BigInt(UNLOCK), WALLET], FEE, CHAIN],
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
    expect((await runLock(tokenPlan, FACTORY, FEE, f.deps)).result).toBe("locked");
    expect(f.sent.map((s) => s.functionName)).toEqual(["lockToken"]);
  });

  it("reads the vault from the factory's own event, never from a forged one in the same receipt", async () => {
    const logs = [tokenLocked(TOKEN, FAKE_VAULT), tokenLocked(FACTORY, FAKE_VAULT, OTHER), tokenLocked(FACTORY, FAKE_VAULT, WALLET, TOKEN_B), tokenLocked(FACTORY, VAULT)];
    expect(vaultFromLogs(logs, FACTORY, tokenPlan, WALLET)).toBe(VAULT);
    expect(vaultFromLogs(logs.slice(0, 3), FACTORY, tokenPlan, WALLET)).toBeNull();
  });

  it("stops before the wallet opens when the fee changed since the form showed it", async () => {
    const f = fake({ fee: 31n * 10n ** 18n });
    expect(await runLock(tokenPlan, FACTORY, FEE, f.deps)).toEqual({
      result: "failed",
      message: "The lock fee changed to 31 USDC. Check it and lock again.",
      approvalLeft: false,
    });
    expect(f.writeContractAsync).not.toHaveBeenCalled();
  });

  it("refuses a wallet on another network before reading or sending anything", async () => {
    const f = fake();
    const outcome = await runLock(tokenPlan, FACTORY, FEE, { ...f.deps, walletChainId: 1 });
    expect(outcome).toMatchObject({ result: "failed", message: "Your wallet is on a different network. Switch to Arc and try again." });
    expect(f.client.readContract).not.toHaveBeenCalled();
  });

  it("says a refused approval plainly, with nothing left behind", async () => {
    const f = fake({ wallet: { approve: rejected } });
    expect(await runLock(tokenPlan, FACTORY, FEE, f.deps)).toEqual({ result: "failed", message: "You cancelled the request in your wallet.", approvalLeft: false });
  });

  it("says when the approval it gave is still in place because the lock was refused", async () => {
    const f = fake({ wallet: { lockToken: rejected } });
    expect(await runLock(tokenPlan, FACTORY, FEE, f.deps)).toEqual({ result: "failed", message: "You cancelled the request in your wallet.", approvalLeft: true });
  });

  it("stops on an approval that reverted, and on a lock that reverted (the fee comes back with it)", async () => {
    const approval = fake({ receipts: { approve: { status: "reverted", logs: [] } } });
    expect(await runLock(tokenPlan, FACTORY, FEE, approval.deps)).toEqual({
      result: "failed",
      message: "The approval reverted, so nothing was locked.",
      hash: "0xapprove",
      approvalLeft: false,
    });
    expect(approval.sent.map((s) => s.functionName)).toEqual(["approve"]);
    const lock = fake({ receipts: { lockToken: { status: "reverted", logs: [] } } });
    expect(await runLock(tokenPlan, FACTORY, FEE, lock.deps)).toEqual({
      result: "failed",
      message: "The lock reverted. Nothing was locked, and the fee wasn't taken.",
      hash: "0xlockToken",
      approvalLeft: true,
    });
  });

  it("never calls a sent lock failed when its outcome is unknown: no receipt, or no vault reported", async () => {
    const lost = fake({ receipts: { lockToken: "lost" } });
    expect(await runLock(tokenPlan, FACTORY, FEE, lost.deps)).toEqual({
      result: "unconfirmed",
      message: "The lock was sent, but it isn't confirmed yet. Check the explorer before you lock again.",
      hash: "0xlockToken",
    });
    const silent = fake();
    expect(await runLock(tokenPlan, FACTORY, FEE, silent.deps)).toMatchObject({ result: "unconfirmed", hash: "0xlockToken" });
    const approvalLost = fake({ receipts: { approve: "lost" } });
    expect(await runLock(tokenPlan, FACTORY, FEE, approvalLost.deps)).toMatchObject({ result: "unconfirmed", hash: "0xapprove" });
    expect(approvalLost.sent.map((s) => s.functionName)).toEqual(["approve"]);
  });

  it("turns a simulated revert into the vault's sentence before the wallet opens", async () => {
    const data = encodeErrorResult({ abi: lockVaultAbi, errorName: "BadUnlockTime" });
    const f = fake({ allowance: 10n ** 30n, simulate: { lockToken: new ContractFunctionRevertedError({ abi: LOCK_ABI as Abi, data, functionName: "lockToken" }) } });
    expect(await runLock(tokenPlan, FACTORY, FEE, f.deps)).toMatchObject({
      result: "failed",
      message: "The unlock date must be in the future, at most 10 years from now, and later than the current one.",
    });
    expect(f.writeContractAsync).not.toHaveBeenCalled();
  });
});

describe("runLock: what the chain says decides", () => {
  const lost = Object.assign(new Error("Request expired"), { code: -32603 });

  it("finds the lock in the registry after a wallet error that came after sending, and reports it with its transaction", async () => {
    const f = fake({
      registry: { before: 3n, added: [FAKE_VAULT, VAULT] },
      vaults: { [FAKE_VAULT.toLowerCase()]: { token: TOKEN_B }, [VAULT.toLowerCase()]: { token: TOKEN } },
      events: [{ transactionHash: "0xfound", args: { vault: VAULT } }],
      wallet: { lockToken: lost },
    });
    expect(await runLock(tokenPlan, FACTORY, FEE, f.deps)).toEqual({ result: "locked", vault: VAULT, hash: "0xfound" });
    expect(f.client.getContractEvents).toHaveBeenCalledWith(expect.objectContaining({ address: FACTORY, eventName: "TokenLocked", args: { owner: WALLET }, fromBlock: 1_000n }));
  });

  it("finds a position's lock by its manager and id", async () => {
    const f = fake({
      registry: { before: 0n, added: [VAULT] },
      vaults: { [VAULT.toLowerCase()]: { manager: MANAGER, tokenId: 7n } },
      wallet: { lockPosition: lost },
    });
    expect(await runLock(positionPlan, FACTORY, FEE, f.deps)).toEqual({ result: "locked", vault: VAULT });
  });

  it("calls the outcome unknown, never failed, when no new lock is listed: no blind second lock", async () => {
    const f = fake({ registry: { before: 2n, added: [] }, wallet: { lockToken: lost } });
    expect(await runLock(tokenPlan, FACTORY, FEE, f.deps)).toEqual({
      result: "unconfirmed",
      message: "Your wallet answered with an error, and no new lock is listed yet. Check Your locks before you lock again.",
    });
    const other = fake({ registry: { before: 0n, added: [FAKE_VAULT] }, vaults: { [FAKE_VAULT.toLowerCase()]: { token: TOKEN_B } }, wallet: { lockToken: lost } });
    expect((await runLock(tokenPlan, FACTORY, FEE, other.deps)).result).toBe("unconfirmed");
  });

  it("says nothing is found when the registry can't be read", async () => {
    const f = fake();
    (f.client.readContract as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"));
    expect(await findLocked(f.client, FACTORY, tokenPlan, WALLET, 0n, 1n)).toBeNull();
  });

  it("goes on to the lock when an approval's wallet error came after it was set, and stops when it wasn't", async () => {
    const set = fake({ wallet: { approve: lost }, receipts: { lockToken: { status: "success", logs: [tokenLocked(FACTORY, VAULT)] } } });
    expect(await runLock(tokenPlan, FACTORY, FEE, set.deps)).toEqual({ result: "locked", vault: VAULT, hash: "0xlockToken" });
    const notSet = fake({ wallet: { approve: lost }, allowanceAfterApprove: 0n });
    expect(await runLock(tokenPlan, FACTORY, FEE, notSet.deps)).toMatchObject({ result: "failed", approvalLeft: false });
    expect(notSet.sent).toEqual([]);
  });

  it("reads the allowance again after a successful approval receipt: a cancelled approval stops before the lock", async () => {
    const f = fake({ allowanceAfterApprove: 999n });
    expect(await runLock(tokenPlan, FACTORY, FEE, f.deps)).toEqual({
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
    expect(await runLock(positionPlan, FACTORY, FEE, f.deps)).toEqual({ result: "locked", vault: VAULT, hash: "0xlockPosition" });
    expect(f.sent.map((s) => [s.functionName, s.address, s.args, s.value])).toEqual([
      ["approve", MANAGER, [FACTORY, 7n], undefined],
      ["lockPosition", FACTORY, [MANAGER, 7n, BigInt(UNLOCK), WALLET], FEE],
    ]);
    expect(f.sent[0]?.abi).toBe(POSITION_NFT_ABI);
  });

  it("skips the approval when the factory is already approved for it, or is an operator", async () => {
    for (const chain of [{ approved: FACTORY }, { operator: true }]) {
      const f = fake({ ...chain, receipts: { lockPosition: { status: "success", logs: [positionLocked(FACTORY, VAULT)] } } });
      expect((await runLock(positionPlan, FACTORY, FEE, f.deps)).result).toBe("locked");
      expect(f.sent.map((s) => s.functionName)).toEqual(["lockPosition"]);
    }
  });

  it("reads a position's vault from PositionLocked for this manager and id only", () => {
    expect(vaultFromLogs([positionLocked(FACTORY, FAKE_VAULT, 8n), positionLocked(FACTORY, VAULT)], FACTORY, positionPlan, WALLET)).toBe(VAULT);
    expect(vaultFromLogs([positionLocked(FACTORY, FAKE_VAULT, 8n)], FACTORY, positionPlan, WALLET)).toBeNull();
  });
});

describe("the calls themselves", () => {
  it("asks for the exact approval only when what is set falls short", async () => {
    const read = (allowance: bigint) => ({ readContract: async () => allowance }) as Pick<FlowClient, "readContract">;
    expect(await approvalFor(tokenPlan, FACTORY, WALLET, read(999n))).toMatchObject({ functionName: "approve", args: [FACTORY, 1000n] });
    expect(await approvalFor(tokenPlan, FACTORY, WALLET, read(1000n))).toBeNull();
  });

  it("locks for the wallet itself", () => {
    expect(lockCall(tokenPlan, FACTORY, WALLET).args?.[3]).toBe(WALLET);
    expect(lockCall(positionPlan, FACTORY, WALLET).args?.[3]).toBe(WALLET);
  });

  it("makes each action's call on the vault's own ABI, and withdraws to the wallet", () => {
    const token = { vault: VAULT, kind: "token" as const };
    const position = { vault: VAULT, kind: "position" as const };
    expect(actionCall(token, { kind: "extend", unlockAt: UNLOCK }, WALLET)).toEqual({ address: VAULT, abi: lockVaultAbi, functionName: "extend", args: [BigInt(UNLOCK)] });
    expect(actionCall(position, { kind: "collect" }, WALLET)).toEqual({ address: VAULT, abi: positionVaultAbi, functionName: "collect", args: [] });
    expect(actionCall(token, { kind: "withdraw" }, WALLET)).toMatchObject({ functionName: "withdraw", args: [WALLET] });
    expect(actionCall(position, { kind: "transfer", to: OTHER }, WALLET)).toMatchObject({ functionName: "transferOwnership", args: [OTHER] });
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

  /** The receipt an action's call gets: from the vault, with the event the vault emits for it. */
  const receiptFor = (kind: "extend" | "withdraw" | "transfer" | "accept", from: Address = VAULT) => {
    const log =
      kind === "extend"
        ? eventLog(from, lockVaultAbi as Abi, "Extended", { unlockAt: BigInt(UNLOCK) })
        : kind === "withdraw"
          ? eventLog(from, lockVaultAbi as Abi, "Withdrawn", { to: WALLET, amount: 1n })
          : kind === "transfer"
            ? eventLog(from, lockVaultAbi as Abi, "OwnershipTransferStarted", { from: WALLET, to: OTHER })
            : eventLog(from, lockVaultAbi as Abi, "OwnershipTransferred", { from: OTHER, to: WALLET });
    return { status: "success" as const, logs: [log], to: VAULT };
  };
  const actions = [
    ["extend", { kind: "extend", unlockAt: UNLOCK }, "extend"],
    ["withdraw", { kind: "withdraw" }, "withdraw"],
    ["transfer", { kind: "transfer", to: OTHER }, "transferOwnership"],
    ["accept", { kind: "accept" }, "acceptOwnership"],
  ] as const;

  it("extends, withdraws, transfers and accepts, each one transaction that counts once the vault's event is in its receipt", async () => {
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
    expect(ACTION_EVENT).toEqual({ extend: "Extended", collect: null, withdraw: "Withdrawn", transfer: "OwnershipTransferStarted", accept: "OwnershipTransferred" });
    expect(actionHappened({ status: "success", logs: [] }, { vault: VAULT, kind: "token" }, { kind: "collect" })).toBe(true);
  });

  it("never calls a wallet error after sending a failure: the vault is read again", async () => {
    const lost = Object.assign(new Error("Request expired"), { code: -32603 });
    expect(await runAction({ vault: VAULT, kind: "token" }, { kind: "withdraw" }, fake({ wallet: { withdraw: lost } }).deps)).toEqual({
      result: "unconfirmed",
      message: "Your wallet answered with an error, so the transaction may or may not have been sent. Check the vault before you try again.",
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
    expect(outcome).toMatchObject({ result: "failed" });
    expect(outcome.result === "failed" && outcome.message).toMatch(/^This vault is locked until .+2030/);
  });
});
