import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAdded, loadVestings } from "../load";
import { forgetFailed } from "../tokenSource";

beforeEach(() => forgetFailed());

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const USER = "0x2222222222222222222222222222222222222222" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const TOKEN = "0x4444444444444444444444444444444444444444" as const;
const W1 = "0x00000000000000000000000000000000000000a1" as const;
const W2 = "0x00000000000000000000000000000000000000a2" as const;
const W3 = "0x00000000000000000000000000000000000000a3" as const;
const E18 = 10n ** 18n;

type Call = { address: string; functionName: string; args?: readonly unknown[] };

/** A chain of three wallets made for USER; W2 has since been handed to OTHER. Wallet W1: 1000 TKN, 100 released, 900 held. */
function fakeClient(over: { events?: (a: { fromBlock: bigint; toBlock?: bigint; args?: { beneficiary: string } }) => unknown; owners?: Record<string, string>; made?: string[] } = {}) {
  const made = over.made ?? [W1, W2, W3];
  const owners: Record<string, string> = { [W1]: USER, [W2]: OTHER, [W3]: USER, ...over.owners };
  const answer = (c: Call): unknown => {
    const w = c.address.toLowerCase();
    switch (c.functionName) {
      case "owner": return owners[w];
      case "start": return 1_000n;
      case "duration": return 1_000n;
      case "cliff": return 1_400n;
      case "balanceOf": return 900n * E18;
      case "released": return 100n * E18;
      case "vestedAmount": return 450n * E18;
      case "releasable": return 350n * E18;
      case "symbol": return "TKN";
      case "decimals": return 18;
      default: throw new Error(`unexpected ${c.functionName}`);
    }
  };
  const multicall = vi.fn(async ({ contracts }: { contracts: Call[] }) => contracts.map((c) => ({ status: "success" as const, result: answer(c) })));
  const readContract = vi.fn(async ({ functionName, args }: Call) => {
    if (functionName === "vestingsOfLength") return BigInt(made.length);
    if (functionName === "vestingsOfSlice") return made.slice(Number((args as bigint[])[1]));
    if (functionName === "isVesting") return (args as string[])[0].toLowerCase() === W1;
    if (functionName === "owner") return owners[(args as string[] | undefined)?.[0] ?? W1];
    if (functionName === "balanceOf") return 900n * E18;
    if (functionName === "released") return 100n * E18;
    throw new Error(`unexpected ${functionName}`);
  });
  // Every wallet was created in block 50; the chain is at block 100.
  const getCode = vi.fn(async ({ blockNumber }: { address?: string; blockNumber: bigint }) => (blockNumber >= 50n ? "0x6080" : undefined));
  const getContractEvents = vi.fn(over.events ?? (async ({ fromBlock }: { fromBlock: bigint; toBlock?: bigint; args?: { beneficiary: string } }) => (fromBlock === 50n ? [W1, W2, W3].map((vesting) => ({ args: { vesting, token: TOKEN } })) : [])));
  const getBlock = vi.fn(async () => ({ timestamp: 1_500n, number: 100n }));
  return { client: { multicall, readContract, getContractEvents, getBlock, getCode } as never, multicall, readContract, getContractEvents, getCode };
}

describe("loadVestings", () => {
  it("lists the wallets the user still owns, newest first, with the wallet's own numbers", async () => {
    const { client } = fakeClient();
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [] });
    expect(data.now).toBe(1_500n);
    expect(data.madeCount).toBe(3);
    expect(data.wallets.map((w) => w.wallet)).toEqual([W3, W1]);
    expect(data.wallets[0]).toMatchObject({ token: TOKEN, tokenInfo: { symbol: "TKN", decimals: 18 }, start: 1_000n, duration: 1_000n, cliff: 400n, released: 100n * E18, vested: 450n * E18, releasable: 350n * E18 });
    // total is what the contract counts: its balance plus what it has released
    expect(data.wallets[0].total).toBe(1000n * E18);
    expect(data.hasMore).toBe(false);
  });

  it("leaves out a wallet whose ownership moved, and says which", async () => {
    const { client } = fakeClient();
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [] });
    expect(data.transferred).toEqual([W2]);
    expect(data.wallets.some((w) => w.wallet === W2)).toBe(false);
  });

  it("pages: reads only the newest `count`", async () => {
    const { client } = fakeClient();
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 1, fromBlock: null, added: [] });
    expect(data.wallets.map((w) => w.wallet)).toEqual([W3]);
    expect(data.hasMore).toBe(true);
  });

  it("finds each wallet's creation block by bisection and reads the event from that block alone", async () => {
    const { client, getContractEvents, getCode } = fakeClient();
    await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [] });
    expect(getContractEvents.mock.calls.every((c) => c[0].fromBlock === 50n && c[0].toBlock === 50n && c[0].args === undefined)).toBe(true);
    // 2 owned-or-not wallets x about log2(100) steps, nowhere near a scan of every block
    expect(getCode.mock.calls.length).toBeLessThan(3 * 9);
  });

  it("looks up tokens only for wallets the user still owns", async () => {
    const { client, getCode } = fakeClient();
    await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [] });
    const looked = new Set(getCode.mock.calls.map((c) => c[0].address?.toLowerCase()));
    expect(looked.has(W2)).toBe(false);
    expect(looked.has(W1) && looked.has(W3)).toBe(true);
  });

  it("does not search again, on the next refresh, for a wallet it already failed to find", async () => {
    const { client, getCode } = fakeClient({ events: async () => [] });
    const a = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [] });
    expect(a.tokenLookupFailed).toBe(true);
    const calls = getCode.mock.calls.length;
    const b = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [] });
    expect(getCode.mock.calls.length).toBe(calls);
    expect(b.tokenLookupFailed).toBe(true);
  });

  it("searches from the configured block, and uses a remembered token without any lookup", async () => {
    const first = fakeClient();
    await loadVestings(first.client, { factory: FACTORY, user: USER, count: 20, fromBlock: 40n, added: [] });
    expect(Math.min(...first.getCode.mock.calls.map((c) => Number(c[0].blockNumber)))).toBeGreaterThanOrEqual(40);
    const cached = fakeClient();
    const cache = { get: () => TOKEN, set: vi.fn() };
    const data = await loadVestings(cached.client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [], cache });
    expect(cached.getCode).not.toHaveBeenCalled();
    expect(data.wallets[0].token).toBe(TOKEN);
  });

  it("remembers what it finds", async () => {
    const { client } = fakeClient();
    const cache = { get: () => undefined, set: vi.fn() };
    await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [], cache });
    expect(cache.set).toHaveBeenCalledWith(W1, TOKEN);
  });

  it("shows no amounts, and says the lookup failed, when the token can't be found; an added token fills them in", async () => {
    const { client } = fakeClient({ events: async () => { throw new Error("range too large"); } });
    const bare = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [] });
    expect(bare.tokenLookupFailed).toBe(true);
    expect(bare.wallets.map((w) => [w.token, w.total, w.releasable])).toEqual([[null, null, null], [null, null, null]]);
    const fixed = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [{ wallet: W1, token: TOKEN }] });
    const w1 = fixed.wallets.find((w) => w.wallet === W1)!;
    expect(w1.total).toBe(1000n * E18);
    expect(fixed.wallets.find((w) => w.wallet === W3)!.total).toBeNull();
  });

  it("lists a wallet the user was handed, marked as added", async () => {
    // W2 was made for someone else and is now owned by USER; only W1 was made for USER.
    const { client } = fakeClient({ made: [W1], owners: { [W2]: USER } });
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [{ wallet: W2, token: TOKEN }] });
    expect(data.wallets.map((w) => [w.wallet, w.source])).toEqual([[W1, "made"], [W2, "added"]]);
    expect(data.transferred).toEqual([]);
  });

  it("does not list an added wallet the user doesn't own", async () => {
    const { client } = fakeClient();
    const data = await loadVestings(client, { factory: FACTORY, user: USER, count: 20, fromBlock: null, added: [{ wallet: W2, token: TOKEN }] });
    expect(data.wallets.some((w) => w.wallet === W2)).toBe(false);
  });
});

describe("checkAdded", () => {
  it("takes a wallet ArcOS made, the user owns, and whose token the wallet holds or the factory names", async () => {
    const { client } = fakeClient();
    expect(await checkAdded(client, FACTORY, USER, W1, TOKEN)).toBeNull(); // holds 900
  });
  it("refuses malformed input, a wallet ArcOS didn't make and one owned by someone else", async () => {
    const { client } = fakeClient();
    expect(await checkAdded(client, FACTORY, USER, "0x12", TOKEN)).toMatch(/vesting wallet/);
    expect(await checkAdded(client, FACTORY, USER, W1, "nope")).toMatch(/token address/);
    expect(await checkAdded(client, FACTORY, USER, W2, TOKEN)).toMatch(/didn't create/);
    expect(await checkAdded(client, FACTORY, OTHER, W1, TOKEN)).toMatch(/another address/);
  });
  it("says so when the typed token can't be confirmed, and refuses one that isn't the wallet's", async () => {
    const empty = fakeClient();
    // a token the wallet holds none of and never released, and no creation event to check it against
    empty.readContract.mockImplementation(async ({ functionName, args }: Call) => {
      if (functionName === "isVesting") return true;
      if (functionName === "owner") return USER;
      if (functionName === "balanceOf" || functionName === "released") return 0n;
      throw new Error(`unexpected ${functionName} ${String(args)}`);
    });
    const nothing = fakeClient({ events: async () => [] });
    nothing.readContract.mockImplementation(empty.readContract.getMockImplementation()!);
    expect(await checkAdded(nothing.client, FACTORY, USER, W1, TOKEN)).toMatch(/Couldn't confirm/);
    // the factory's own event names another token for this wallet
    const OTHER_TOKEN = "0x5555555555555555555555555555555555555555";
    const wrong = fakeClient({ events: async () => [{ args: { vesting: W1, token: OTHER_TOKEN } }] });
    wrong.readContract.mockImplementation(empty.readContract.getMockImplementation()!);
    expect(await checkAdded(wrong.client, FACTORY, USER, W1, TOKEN)).toMatch(/isn't the token this schedule was made for/);
    // and when it does name it, it is confirmed
    const right = fakeClient({ events: async () => [{ args: { vesting: W1, token: TOKEN } }] });
    right.readContract.mockImplementation(empty.readContract.getMockImplementation()!);
    expect(await checkAdded(right.client, FACTORY, USER, W1, TOKEN)).toBeNull();
  });
});
